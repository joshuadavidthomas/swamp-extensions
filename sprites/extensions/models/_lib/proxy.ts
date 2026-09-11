// SPDX-License-Identifier: MIT
/** Loopback TCP proxying over an authenticated exec relay. @module */
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import * as net from "node:net";
import { z } from "zod";
import { concatenate, deadline, method, type Query, resource } from "./core.ts";
import {
  type Channel,
  type ConnectChannel,
  openChannel,
  readChannel,
} from "./socket.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite-api.ts";
import { decodeStreamFrame } from "./exec-http.ts";
const PYTHON = "/.sprite/bin/python3";
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

const STDIN = 0;
const EOF = 4;

type Control = { type: string; exit_code?: number; error?: unknown };

function failure(message: string): Error {
  return new Error(`Sprite exec TCP relay ${message}`);
}

function parseControl(bytes: Uint8Array): Control {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !value || typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) throw new Error();
    const control = value as Control;
    if (control.type === "error" || control.error !== undefined) {
      throw failure("reported an exec protocol error.");
    }
    if (
      !["session_info", "debug", "port_opened", "port_closed", "exit"].includes(
        control.type,
      )
    ) {
      throw new Error();
    }
    if (
      control.type === "exit" &&
      (typeof control.exit_code !== "number" ||
        !Number.isInteger(control.exit_code) || control.exit_code < 0)
    ) throw new Error();
    return control;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Sprite exec")) {
      throw error;
    }
    throw failure("received an invalid JSON control frame.");
  }
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
          "Sprite exec TCP relay",
        );
        if (this.#finished) return;
        this.budget.check("Sprite exec TCP relay exceeded timeoutMs.");
        if (!message) throw failure("WebSocket closed without an exit frame.");
        if (!message.binary) {
          const control = parseControl(message.bytes);
          if (control.type !== "exit") continue;
          await this.#complete(control.exit_code!);
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
    await this.#cleanup(true);
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const frame = new Uint8Array(chunk.length + 1);
    frame[0] = STDIN;
    frame.set(chunk, 1);
    this.channel.send(frame).then(
      () => callback(),
      () => callback(failure("send failed.")),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.#exited) {
      callback();
      return;
    }
    this.channel.send(new Uint8Array([EOF])).then(
      () => callback(),
      () => callback(failure("could not send stdin EOF.")),
    );
  }

  #cleanup(exited = this.#exited): Promise<void> {
    if (!this.#cleanupPromise) {
      this.budget.dispose();
      this.budget.signal.removeEventListener("abort", this.#onAbort);
      this.#cleanupPromise = stopOwned(this.channel, exited);
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
      () => callback(error ?? failure("cleanup failed.")),
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
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw failure("target is invalid.");
  }
  const budget = deadline(ctx);
  const { signal } = budget;
  let channel: Channel | undefined;
  let exited = false;
  try {
    await verifySprite({ ...ctx, signal });
    signal.throwIfAborted();
    const remaining = budget.remainingMs();
    if (remaining <= 0) throw failure("exceeded timeoutMs before connecting.");
    const query: Query = {
      cmd: [
        PYTHON,
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
        "Sprite exec TCP relay",
      );
      if (!message) throw failure("disconnected before connecting.");
      handshakeBytes += message.bytes.length;
      if (handshakeBytes > ctx.globalArgs.maxResponseBytes) {
        throw failure("handshake exceeded maxResponseBytes.");
      }
      if (!message.binary) {
        const control = parseControl(message.bytes);
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
const ProxyArgs = z.object({
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

/** Dependencies used by the loopback listener, exposed for deterministic tests. */
export type ProxyDependencies = {
  connect?: ConnectChannel;
  createServer?: typeof net.createServer;
};

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
  let resolveOutcome: (value: ConnectionOutcome) => void = () => {};
  const connectionDone = new Promise<ConnectionOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
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

  try {
    let onTunnelData: ((chunk: Buffer) => void) | undefined;
    let onTunnelEnd: (() => void) | undefined;
    let onTunnelClose: (() => void) | undefined;
    let onTunnelError: ((error: Error) => void) | undefined;
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
      onTunnelData = (chunk: Buffer): void => {
        bytesFromRemote += chunk.length;
      };
      onTunnelEnd = (): void => {
        remoteEnded = true;
        if (socketClosed) {
          finishConnection({ kind: "clean-remote-eof" });
        }
      };
      onTunnelClose = (): void => {
        if (remoteEnded || socketClosed || outcome) return;
        finishConnection({
          kind: "error",
          error: new Error(
            "Sprite TCP proxy tunnel closed before remote EOF.",
          ),
        });
      };
      onTunnelError = (error: Error): void => {
        finishConnection({ kind: "error", error });
      };
      tunnel.on("data", onTunnelData);
      tunnel.once("end", onTunnelEnd);
      tunnel.once("close", onTunnelClose);
      tunnel.once("error", onTunnelError);
      socket.on("data", onSocketData);
      if (socketClosed) return { bytesFromClients, bytesFromRemote };
      socket.pipe(tunnel).pipe(socket);
      socket.resume();
      const result = await connectionDone;
      if (result.kind === "error") {
        throw new Error("A loopback TCP proxy connection failed.", {
          cause: result.error,
        });
      }
    } finally {
      socket.off("error", onSocketError);
      socket.off("close", onSocketClose);
      socket.off("end", onSocketEnd);
      socket.off("data", onSocketData);
      if (tunnel) {
        if (onTunnelData) tunnel.off("data", onTunnelData);
        if (onTunnelEnd) tunnel.off("end", onTunnelEnd);
        if (onTunnelClose) tunnel.off("close", onTunnelClose);
        if (onTunnelError) {
          const ownedTunnel = tunnel;
          const handler = onTunnelError;
          tunnel.once("close", () => ownedTunnel.off("error", handler));
        }
      }
      socket.destroy();
      tunnel?.destroy();
    }
  } catch (error) {
    if (!(durationEnded() && phase === "established")) throw error;
  }
  return { bytesFromClients, bytesFromRemote };
}

/** Own a loopback listener and every accepted socket within one global timeout budget. */
export async function runProxy(
  ctx: SpriteContext,
  input: z.input<typeof ProxyArgs>,
  dependencies: ProxyDependencies = {},
): Promise<z.output<typeof ProxyOutput>> {
  const args = ProxyArgs.parse(input);
  ctx.signal.throwIfAborted();
  const budget = deadline(ctx);
  // WebSocket frames also occupy Node buffers, so queued payloads alone stay
  // within 128 MiB across the configured connection cap.
  const connectionQueueBytes = Math.min(
    ctx.globalArgs.maxResponseBytes,
    MAX_PROXY_QUEUE_BYTES,
    Math.floor(MAX_PROXY_AGGREGATE_QUEUE_BYTES / args.maxConnections),
  );
  const timeoutError = new Error("TCP proxy exceeded timeoutMs.");
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
  let rejectFailure: (error: Error) => void = () => {};
  const connectionFailure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  let firstFailure: Error | undefined;
  const fail = (message: string): void => {
    if (firstFailure) return;
    firstFailure = new Error(message);
    rejectFailure(firstFailure);
  };
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
        error instanceof Error && error.message.includes("timeoutMs")
          ? timeoutError.message
          : "A loopback TCP proxy connection failed.",
      );
    }).finally(() => {
      sockets.delete(socket);
      completedConnections += 1;
      tasks.delete(task);
    });
    tasks.add(task);
  });

  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => fail("TCP proxy was cancelled.");
  const onTimeout = (): void => fail(timeoutError.message);
  const onServerError = (): void =>
    fail("The loopback TCP proxy listener failed.");
  const onBindError = (): void =>
    fail("Could not bind the loopback TCP proxy listener.");
  const checkGlobalDeadline = (): void => budget.check(timeoutError.message);
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
    let closeResolved = false;
    const serverClosed = new Promise<void>((resolve) => {
      const done = (): void => {
        if (closeResolved) return;
        closeResolved = true;
        resolve();
      };
      try {
        server.close(done);
      } catch {
        done();
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
  ctx.signal.throwIfAborted();
  budget.signal.throwIfAborted();
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
