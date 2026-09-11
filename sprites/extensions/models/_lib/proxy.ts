// SPDX-License-Identifier: MIT
/** Loopback TCP proxying over an authenticated exec relay.
 *
 * The API has a native /v1/sprites/{name}/proxy WebSocket: one JSON {host, port} message, then a
 * transparent relay. It was implemented here and tested live, and neither it nor the /control proxy
 * operation forwarded TCP half-close to the client. So this module runs a Python relay over the
 * documented exec WebSocket instead. That is a workaround for an observed defect; re-probe the
 * native route before building on this choice. @module */
import * as net from "node:net";
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import { z } from "zod";
import {
  concatenate,
  deadline,
  decodeFrame,
  method,
  type Query,
  resource,
} from "./core.ts";
import {
  type Channel,
  type ConnectChannel,
  openChannel,
  readChannel,
} from "./socket.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite.ts";
import {
  decodeStreamFrame,
  EOF_FRAME,
  ExecControl,
  stdinFrame,
} from "./exec.ts";

const ACK = new TextEncoder().encode("connected\n");
const PROGRAM = String.raw`import os,socket,sys,threading

def die():
 os.write(2,b"relay failed\n")
 os._exit(1)

def send_input():
 try:
  while True:
   data=os.read(0,65536)
   if not data: break
   sock.sendall(data)
  try: sock.shutdown(socket.SHUT_WR)
  except OSError: pass
 except BaseException: die()

timer=threading.Timer(float(sys.argv[3]),lambda:os._exit(124))
timer.daemon=True
timer.start()
try:
 sock=socket.create_connection((sys.argv[1],int(sys.argv[2])))
except BaseException: die()
os.write(2,b"connected\n")
threading.Thread(target=send_input,daemon=True).start()
try:
 while True:
  data=sock.recv(65536)
  if not data: break
  sys.stdout.buffer.write(data)
  sys.stdout.buffer.flush()
except BaseException: die()
sys.exit(0)`;

function failure(message: string): Error {
  return new Error(`Sprite exec TCP relay ${message}`);
}

async function stopOwned(channel: Channel, exited: boolean): Promise<void> {
  if (!exited) {
    try {
      await channel.send(JSON.stringify({ type: "signal", signal: "SIGTERM" }));
    } catch {
      // Closing the owned channel is the final cleanup boundary.
    }
  }
  await channel.close();
}

class RelayCleanupError extends Error {
  constructor() {
    super("Sprite exec TCP relay cleanup failed.");
  }
}

class ExecProxyDuplex extends Duplex {
  #reading = false;
  #finished = false;
  #exited = false;
  #cleanupPromise: Promise<void> | undefined;
  readonly #onAbort = (): void => {
    this.destroy(failure("was cancelled."));
  };

  constructor(
    private readonly channel: Channel,
    private readonly budget: ReturnType<typeof deadline>,
    private readonly queued: Buffer[],
  ) {
    super({ allowHalfOpen: false });
    budget.signal.addEventListener("abort", this.#onAbort, { once: true });
    if (budget.signal.aborted) this.#onAbort();
  }

  override _read(): void {
    if (this.#reading || this.#finished) return;
    while (this.queued.length) {
      if (!this.push(this.queued.shift()!)) return;
    }
    this.#reading = true;
    this.#pump().catch((error) =>
      this.destroy(error instanceof Error ? error : failure("receive failed."))
    );
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#finished) {
        this.budget.check("Sprite exec TCP relay exceeded timeoutMs.");
        const message = await readChannel(
          this.channel,
          this.budget.signal,
        );
        if (this.#finished) return;
        this.budget.check("Sprite exec TCP relay exceeded timeoutMs.");
        if (!message) throw failure("WebSocket closed without an exit frame.");
        if (!message.binary) {
          const control = decodeFrame(
            message.bytes,
            ExecControl,
            "Sprite exec TCP relay received an invalid JSON control frame.",
          );
          if (
            control.type === "error" ||
            ("error" in control && control.error !== undefined)
          ) throw failure("reported an exec protocol error.");
          if (control.type !== "exit") continue;
          await this.#complete(control.exit_code);
          return;
        }
        const frame = decodeStreamFrame(message.bytes);
        if (frame.kind === "exit") {
          await this.#complete(frame.code);
          return;
        }
        if (frame.kind !== "stdout") {
          throw failure("received an unexpected binary stream frame.");
        }
        const chunk = Buffer.from(frame.data);
        if (chunk.length && !this.push(chunk)) return;
      }
    } finally {
      this.#reading = false;
    }
  }

  async #complete(code: number): Promise<void> {
    this.#exited = true;
    this.#finished = true;
    if (code !== 0) throw failure(`process exited with code ${code}.`);
    this.push(null);
    await this.#cleanup();
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.channel.send(stdinFrame(false, chunk)).then(
      () => callback(),
      () => callback(failure("send failed.")),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.#exited) {
      callback();
      return;
    }
    this.channel.send(EOF_FRAME).then(
      () => callback(),
      () => callback(failure("could not send stdin EOF.")),
    );
  }

  #cleanup(): Promise<void> {
    if (!this.#cleanupPromise) {
      this.budget.dispose();
      this.budget.signal.removeEventListener("abort", this.#onAbort);
      this.#cleanupPromise = stopOwned(this.channel, this.#exited);
    }
    return this.#cleanupPromise;
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#finished = true;
    this.#cleanup().then(
      () => callback(error),
      () => callback(new RelayCleanupError()),
    );
  }
}

/** Connect to a TCP target from inside one verified Sprite. */
export async function connectExecProxy(
  ctx: SpriteContext,
  host: string,
  port: number,
  connect: ConnectChannel = openChannel,
): Promise<Duplex> {
  const budget = deadline(ctx);
  const { signal } = budget;
  let channel: Channel | undefined;
  let exited = false;
  try {
    signal.throwIfAborted();
    const remaining = budget.remainingMs();
    if (remaining <= 0) throw failure("exceeded timeoutMs before connecting.");
    const query: Query = {
      cmd: [
        "/.sprite/bin/python3",
        "-I",
        "-u",
        "-c",
        PROGRAM,
        host,
        String(port),
        String(remaining / 1000),
      ],
      stdin: true,
      tty: false,
      max_run_after_disconnect: "1s",
    };
    channel = await connect(
      { ...ctx, signal },
      spritePath(ctx, "/exec"),
      query,
    );
    const queued: Buffer[] = [];
    let handshakeBytes = 0;
    let ack: Uint8Array = new Uint8Array();
    while (ack.length < ACK.length) {
      budget.check("Sprite exec TCP relay handshake exceeded timeoutMs.");
      const message = await readChannel(
        channel,
        signal,
      );
      if (!message) throw failure("disconnected before connecting.");
      handshakeBytes += message.bytes.length;
      if (handshakeBytes > ctx.globalArgs.maxResponseBytes) {
        throw failure("handshake exceeded maxResponseBytes.");
      }
      if (!message.binary) {
        const control = decodeFrame(
          message.bytes,
          ExecControl,
          "Sprite exec TCP relay received an invalid JSON control frame.",
        );
        if (
          control.type === "error" ||
          ("error" in control && control.error !== undefined)
        ) throw failure("reported an exec protocol error.");
        if (control.type === "exit") {
          exited = true;
          throw failure(`process exited with code ${control.exit_code}.`);
        }
        continue;
      }
      const frame = decodeStreamFrame(message.bytes);
      if (frame.kind === "exit") {
        exited = true;
        throw failure(`process exited with code ${frame.code}.`);
      }
      if (frame.kind === "stdout") {
        if (frame.data.length) queued.push(Buffer.from(frame.data));
        continue;
      }
      ack = concatenate([ack, frame.data]);
      for (let index = 0; index < ack.length; index++) {
        if (index >= ACK.length || ack[index] !== ACK[index]) {
          throw failure("did not receive the connection acknowledgement.");
        }
      }
    }
    budget.check("Sprite exec TCP relay handshake exceeded timeoutMs.");
    return new ExecProxyDuplex(channel, budget, queued);
  } catch (error) {
    const expired = budget.remainingMs() === 0;
    budget.dispose();
    if (channel) {
      try {
        await stopOwned(channel, exited);
      } catch {
        // Preserve the bounded protocol or cancellation error.
      }
    }
    if (expired) throw failure("exceeded timeoutMs.");
    throw error;
  }
}

const Port = z.number().int().min(1).max(65_535);
export const ProxyArgs = z.object({
  localPort: Port.describe(
    "Required port bound only on the IPv4 loopback interface.",
  ),
  host: z.string().min(1).describe(
    "Remote host reached from inside the Sprite.",
  ),
  port: Port.describe("Remote TCP port reached from inside the Sprite."),
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxConnections: z.number().int().positive().max(1_024).default(32),
});
const ProxyOutput = z.object({
  localAddress: z.literal("127.0.0.1"),
  localPort: Port,
  remoteHost: z.string(),
  remotePort: Port,
  acceptedConnections: z.number().int().nonnegative(),
  completedConnections: z.number().int().nonnegative(),
  rejectedConnections: z.number().int().nonnegative(),
  bytesFromClients: z.number().int().nonnegative(),
  bytesFromRemote: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  closed: z.literal(true),
});
const MAX_PROXY_QUEUE_BYTES = 1024 * 1024;
const MAX_PROXY_AGGREGATE_QUEUE_BYTES = 128 * 1024 * 1024;

async function runConnection(
  socket: net.Socket,
  ctx: SpriteContext,
  args: z.output<typeof ProxyArgs>,
  connect: ConnectChannel,
  durationEnded: () => boolean,
): Promise<{ bytesFromClients: number; bytesFromRemote: number }> {
  let bytesFromClients = 0;
  let bytesFromRemote = 0;
  const connectionLifetime = new AbortController();
  const connectionSignal = AbortSignal.any([
    ctx.signal,
    connectionLifetime.signal,
  ]);
  let phase: "pending" | "established" = "pending";
  let tunnel: Duplex | undefined;
  let socketClosed = false;
  let socketFailed = false;
  let remoteEnded = false;
  type ConnectionOutcome =
    | { kind: "clean-remote-eof" | "client-close" }
    | { kind: "error"; error: Error };
  let outcome: ConnectionOutcome | undefined;
  const { promise: connectionDone, resolve: resolveOutcome } = Promise
    .withResolvers<ConnectionOutcome>();
  const finishConnection = (value: ConnectionOutcome): void => {
    if (outcome) return;
    outcome = value;
    resolveOutcome(value);
  };
  const onSocketError = (error: Error): void => {
    socketFailed = true;
    connectionLifetime.abort(error);
    finishConnection({ kind: "error", error });
  };
  const onSocketClose = (): void => {
    socketClosed = true;
    if (!connectionLifetime.signal.aborted) {
      connectionLifetime.abort(new Error("Loopback TCP client closed."));
    }
    if (socketFailed) return;
    finishConnection({
      kind: remoteEnded ? "clean-remote-eof" : "client-close",
    });
  };
  const onSocketData = (chunk: Buffer): void => {
    bytesFromClients += chunk.length;
  };
  const onSocketEnd = (): void => {
    if (phase === "pending") socket.destroy();
  };
  // Install these before starting the remote handshake: paused sockets can
  // still close or emit an error before connectExecProxy resolves.
  socket.once("error", onSocketError);
  socket.once("close", onSocketClose);
  socket.once("end", onSocketEnd);
  socket.read(0);

  let primaryFailed = false;
  try {
    let handlers: {
      data: (chunk: Buffer) => void;
      end: () => void;
      close: () => void;
      error: (error: Error) => void;
    } | undefined;
    try {
      try {
        tunnel = await connectExecProxy(
          {
            ...ctx,
            signal: connectionSignal,
          },
          args.host,
          args.port,
          connect,
        );
      } catch (error) {
        if (
          socketClosed && !socketFailed &&
          !ctx.signal.aborted
        ) {
          return { bytesFromClients, bytesFromRemote };
        }
        throw error;
      }
      phase = "established";
      handlers = {
        data: (chunk: Buffer): void => {
          bytesFromRemote += chunk.length;
        },
        end: (): void => {
          remoteEnded = true;
          if (socketClosed) {
            finishConnection({ kind: "clean-remote-eof" });
          }
        },
        close: (): void => {
          if (remoteEnded || socketClosed || outcome) return;
          finishConnection({
            kind: "error",
            error: new Error(
              "Sprite TCP proxy tunnel closed before remote EOF.",
            ),
          });
        },
        error: (error: Error): void => {
          finishConnection({ kind: "error", error });
        },
      };
      tunnel.on("data", handlers.data);
      tunnel.once("end", handlers.end);
      tunnel.once("close", handlers.close);
      tunnel.on("error", handlers.error);
      socket.on("data", onSocketData);
      if (socketClosed) return { bytesFromClients, bytesFromRemote };
      socket.pipe(tunnel).pipe(socket);
      socket.resume();
      const result = await connectionDone;
      if (result.kind === "error") {
        if (result.error instanceof RelayCleanupError) throw result.error;
        throw new Error("A loopback TCP proxy connection failed.", {
          cause: result.error,
        });
      }
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
      socket.off("end", onSocketEnd);
      socket.off("data", onSocketData);
      if (tunnel && handlers) {
        tunnel.off("data", handlers.data);
        tunnel.off("end", handlers.end);
        tunnel.off("close", handlers.close);
        const ownedTunnel = tunnel;
        const handler = handlers.error;
        tunnel.once("close", () => ownedTunnel.off("error", handler));
      }
      socket.destroy();
      if (tunnel) {
        const ownedTunnel = tunnel;
        const closed = new Promise<void>((resolve, reject) => {
          if (ownedTunnel.closed) {
            if (ownedTunnel.errored) reject(ownedTunnel.errored);
            else resolve();
            return;
          }
          const onError = (error: Error): void => reject(error);
          ownedTunnel.on("error", onError);
          ownedTunnel.once("close", () => {
            ownedTunnel.off("error", onError);
            resolve();
          });
        });
        ownedTunnel.destroy();
        await closed.catch((error: unknown) => {
          if (!primaryFailed) throw error;
          // Preserve the primary connection error over a cleanup failure.
        });
      }
    }
  } catch (error) {
    if (
      error instanceof RelayCleanupError ||
      !(durationEnded() && phase === "established")
    ) throw error;
  }
  return { bytesFromClients, bytesFromRemote };
}

/** Own a loopback listener and every accepted socket within one global timeout budget. */
export async function runProxy(
  ctx: SpriteContext,
  args: z.output<typeof ProxyArgs>,
  dependencies: {
    connect?: ConnectChannel;
    createServer?: typeof net.createServer;
  } = {},
): Promise<z.output<typeof ProxyOutput>> {
  ctx.signal.throwIfAborted();
  const budget = deadline(ctx);
  // WebSocket frames also occupy Node buffers, so queued payloads alone stay
  // within 128 MiB across the configured connection cap.
  const connectionQueueBytes = Math.min(
    ctx.globalArgs.maxResponseBytes,
    MAX_PROXY_QUEUE_BYTES,
    Math.floor(MAX_PROXY_AGGREGATE_QUEUE_BYTES / args.maxConnections),
  );
  const TIMEOUT_MESSAGE = "TCP proxy exceeded timeoutMs.";
  const lifetime = new AbortController();
  const sessionContext = {
    ...ctx,
    signal: AbortSignal.any([
      budget.signal,
      lifetime.signal,
    ]),
  };
  const sockets = new Set<net.Socket>();
  const tasks = new Set<Promise<void>>();
  let acceptedConnections = 0;
  let completedConnections = 0;
  let rejectedConnections = 0;
  let bytesFromClients = 0;
  let bytesFromRemote = 0;
  let durationEnded = false;
  const createServer = dependencies.createServer ?? net.createServer;
  const connect = dependencies.connect ?? openChannel;
  const { promise: connectionFailure, reject: rejectFailure } = Promise
    .withResolvers<never>();
  let firstFailure: Error | undefined;
  const fail = (error: Error): void => {
    if (firstFailure) return;
    firstFailure = error;
    rejectFailure(firstFailure);
  };
  try {
    await verifySprite({ ...ctx, signal: budget.signal });
    budget.check(TIMEOUT_MESSAGE);
  } catch (error) {
    budget.dispose();
    throw error;
  }
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    acceptedConnections += 1;
    if (sockets.size >= args.maxConnections) {
      rejectedConnections += 1;
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const task = runConnection(
      socket,
      {
        ...sessionContext,
        globalArgs: {
          ...ctx.globalArgs,
          timeoutMs: Math.max(1, Math.floor(budget.remainingMs())),
          maxResponseBytes: connectionQueueBytes,
        },
      },
      args,
      connect,
      () => durationEnded,
    ).then((counts) => {
      bytesFromClients += counts.bytesFromClients;
      bytesFromRemote += counts.bytesFromRemote;
    }).catch((error: unknown) => {
      fail(
        budget.signal.aborted
          ? new Error(TIMEOUT_MESSAGE)
          : error instanceof Error
          ? error
          : new Error("A loopback TCP proxy connection failed.", {
            cause: error,
          }),
      );
    }).finally(() => {
      sockets.delete(socket);
      completedConnections += 1;
      tasks.delete(task);
    });
    tasks.add(task);
  });

  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => fail(new Error("TCP proxy was cancelled."));
  const onTimeout = (): void => fail(new Error(TIMEOUT_MESSAGE));
  const onServerError = (): void =>
    fail(new Error("The loopback TCP proxy listener failed."));
  const onBindError = (): void =>
    fail(new Error("Could not bind the loopback TCP proxy listener."));
  const checkGlobalDeadline = (): void => budget.check(TIMEOUT_MESSAGE);
  ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  budget.signal.addEventListener("abort", onTimeout, { once: true });
  if (ctx.signal.aborted) onParentAbort();
  if (budget.signal.aborted) onTimeout();
  try {
    const binding = new Promise<void>((resolve) => {
      server.once("error", onBindError);
      server.listen({
        host: "127.0.0.1",
        port: args.localPort,
        exclusive: true,
      }, () => {
        server.off("error", onBindError);
        resolve();
      });
    });
    await Promise.race([binding, connectionFailure]);
    checkGlobalDeadline();
    if (firstFailure) throw firstFailure;
    server.on("error", onServerError);
    const duration = new Promise<"duration">((resolve) => {
      durationTimer = setTimeout(() => resolve("duration"), args.durationMs);
    });
    await Promise.race([duration, connectionFailure]);
    durationEnded = true;
    checkGlobalDeadline();
    if (firstFailure) throw firstFailure;
  } finally {
    if (durationTimer !== undefined) clearTimeout(durationTimer);
    server.off("error", onBindError);
    server.off("error", onServerError);
    const serverClosed = new Promise<Error | undefined>((resolve) => {
      try {
        server.close(resolve);
      } catch {
        resolve(undefined);
      }
    });
    lifetime.abort(new Error("TCP proxy observation ended."));
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([...tasks]);
    await serverClosed;
    budget.dispose();
    ctx.signal.removeEventListener("abort", onParentAbort);
    budget.signal.removeEventListener("abort", onTimeout);
  }
  checkGlobalDeadline();
  if (firstFailure) throw firstFailure;
  return {
    localAddress: "127.0.0.1",
    localPort: args.localPort,
    remoteHost: args.host,
    remotePort: args.port,
    acceptedConnections,
    completedConnections,
    rejectedConnections,
    bytesFromClients,
    bytesFromRemote,
    durationMs: args.durationMs,
    closed: true,
  };
}

export const proxyResources = {
  proxy: resource(ProxyOutput, "Closed loopback TCP proxy observation", "7d"),
};
export const proxyMethods = {
  proxy: method(
    "Run a bounded loopback-only TCP proxy through the Sprite",
    ProxyArgs,
    "proxy",
    ProxyOutput,
    (args, ctx: SpriteContext) => runProxy(ctx, args),
  ),
};
