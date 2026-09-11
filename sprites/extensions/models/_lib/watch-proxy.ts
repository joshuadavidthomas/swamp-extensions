// SPDX-License-Identifier: MIT
/** Bounded filesystem observation and loopback TCP proxying for one Sprite. @module */
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import * as net from "node:net";
import { z } from "zod";
import { resource, type Result } from "./core.ts";
import { type Channel, type ConnectChannel, openChannel } from "./socket.ts";
import { type SpriteContext, spritePath } from "./sprite-api.ts";
import { connectExecProxy } from "./exec-proxy.ts";

const EventKind = z.enum(["write", "create", "remove", "rename", "chmod"]);
const Subscribed = z.object({
  type: z.literal("subscribed"),
  paths: z.array(z.string()).optional(),
});
const WatchEvent = z.object({
  type: z.literal("event"),
  path: z.string().optional(),
  event: EventKind.optional(),
  timestamp: z.string().optional(),
  size: z.number().optional(),
  isDir: z.boolean().optional(),
});
const WatchError = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
});
const WatchMessage = z.discriminatedUnion("type", [
  Subscribed,
  WatchEvent,
  WatchError,
]);
const WatchOutput = z.object({
  events: z.array(WatchEvent),
  truncated: z.literal(true).describe(
    "True because observation ends at durationMs or maxEvents, not at an exhaustive filesystem boundary.",
  ),
});
const STOP = Symbol("duration elapsed");

const WatchArgs = z.object({
  paths: z.array(z.string()).min(1),
  recursive: z.boolean().default(false),
  workingDir: z.string().min(1).default("/"),
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxEvents: z.number().int().positive().max(100_000).default(1_000),
});

const Port = z.number().int().min(1).max(65_535);
const ProxyTransport = z.enum(["exec", "proxy", "control"]);
const ProxyArgs = z.object({
  localPort: Port.describe(
    "Required port bound only on the IPv4 loopback interface.",
  ),
  host: z.string().min(1).describe(
    "Remote host reached from inside the Sprite.",
  ),
  port: Port.describe("Remote TCP port reached from inside the Sprite."),
  transport: ProxyTransport.default("exec").describe(
    "Exec relay delivers TCP EOF. Native proxy/control modes remain explicit protocol options with provider EOF limitations.",
  ),
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxConnections: z.number().int().positive().max(1_024).default(32),
});
const ProxyOutput = z.object({
  localAddress: z.literal("127.0.0.1"),
  localPort: Port,
  remoteHost: z.string(),
  remotePort: Port,
  transport: ProxyTransport,
  acceptedConnections: z.number().int().nonnegative(),
  completedConnections: z.number().int().nonnegative(),
  rejectedConnections: z.number().int().nonnegative(),
  bytesFromClients: z.number().int().nonnegative(),
  bytesFromRemote: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  closed: z.literal(true),
});
const Connected = z.object({ status: z.literal("connected") });
const MAX_PROXY_QUEUE_BYTES = 1024 * 1024;
const MAX_PROXY_AGGREGATE_QUEUE_BYTES = 128 * 1024 * 1024;

function parseControl(
  bytes: Uint8Array,
  operation: string,
): z.output<typeof WatchMessage> {
  try {
    return WatchMessage.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new Error(`${operation} returned an invalid JSON control frame.`);
  }
}

function watchError(message: string | undefined, token: string): Error {
  const reason = message?.replaceAll(token, "[redacted]").replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    " ",
  ).slice(0, 512);
  return new Error(
    `Filesystem watch reported an error${reason ? `: ${reason}` : "."}`,
  );
}

async function readWithAbort(
  channel: Channel,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<Channel["read"]>>> {
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(
        signal.reason ?? new Error("Sprite streaming operation was cancelled."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    channel.read().then(
      (message) => {
        cleanup();
        resolve(message);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/** Observe one acknowledged watch subscription until its duration or event cap. */
export async function observeWatch(
  ctx: SpriteContext,
  input: z.input<typeof WatchArgs>,
  connect: ConnectChannel = openChannel,
): Promise<z.output<typeof WatchOutput>> {
  const args = WatchArgs.parse(input);
  ctx.signal.throwIfAborted();
  const globalDeadline = performance.now() + ctx.globalArgs.timeoutMs;
  const timeout = new AbortController();
  const timeoutError = new Error("Filesystem watch exceeded timeoutMs.");
  const timeoutTimer = setTimeout(
    () => timeout.abort(timeoutError),
    ctx.globalArgs.timeoutMs,
  );
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  const checkGlobalDeadline = (): void => {
    signal.throwIfAborted();
    if (performance.now() >= globalDeadline) throw timeoutError;
  };
  let channel: Channel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    channel = await connect(
      { ...ctx, signal },
      spritePath(ctx, "/fs/watch"),
    );
    checkGlobalDeadline();
    await channel.send(JSON.stringify({
      type: "subscribe",
      paths: args.paths,
      recursive: args.recursive,
      workingDir: args.workingDir,
    }));
    checkGlobalDeadline();
    const first = await readWithAbort(channel, signal);
    checkGlobalDeadline();
    if (!first) {
      throw new Error(
        "Filesystem watch disconnected before acknowledging its subscription.",
      );
    }
    if (first.binary) {
      throw new Error(
        "Filesystem watch returned a binary subscription acknowledgement.",
      );
    }
    const acknowledgement = parseControl(first.bytes, "Filesystem watch");
    if (acknowledgement.type === "error") {
      throw watchError(acknowledgement.message, ctx.globalArgs.token);
    }
    if (acknowledgement.type !== "subscribed") {
      throw new Error("Filesystem watch did not acknowledge its subscription.");
    }

    ctx.logger.info("Filesystem subscription acknowledged");
    // The observation window starts after the server acknowledges the subscription.
    const durationDeadline = performance.now() + args.durationMs;
    const stopped = new Promise<typeof STOP>((resolve) => {
      timer = setTimeout(() => resolve(STOP), args.durationMs);
    });
    const events: z.output<typeof WatchEvent>[] = [];
    let receivedBytes = first.bytes.length;
    while (events.length < args.maxEvents) {
      checkGlobalDeadline();
      if (performance.now() >= durationDeadline) break;
      const next = await Promise.race([
        readWithAbort(channel, signal),
        stopped,
      ]);
      checkGlobalDeadline();
      if (next === STOP || performance.now() >= durationDeadline) break;
      if (!next) {
        throw new Error(
          "Filesystem watch disconnected before its bounded observation ended.",
        );
      }
      if (next.binary) {
        throw new Error(
          "Filesystem watch returned an unexpected binary frame.",
        );
      }
      receivedBytes += next.bytes.length;
      if (receivedBytes > ctx.globalArgs.maxResponseBytes) {
        throw new Error(
          "Filesystem watch exceeded maxResponseBytes; no result was saved.",
        );
      }
      const value = parseControl(next.bytes, "Filesystem watch");
      if (value.type === "error") {
        throw watchError(value.message, ctx.globalArgs.token);
      }
      if (value.type === "subscribed") {
        throw new Error(
          "Filesystem watch returned an unexpected second subscription acknowledgement.",
        );
      }
      events.push(value);
    }
    checkGlobalDeadline();
    const output = WatchOutput.parse({ events, truncated: true });
    checkGlobalDeadline();
    return output;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    clearTimeout(timeoutTimer);
    await channel?.close();
  }
}

/** Adapt the Sprite TCP proxy protocol to an owned Node Duplex stream. */
export async function connectProxy(
  ctx: SpriteContext,
  host: string,
  port: number,
  connect: ConnectChannel = openChannel,
  transport: z.input<typeof ProxyTransport> = "proxy",
): Promise<Duplex> {
  const target = z.object({ host: z.string().min(1), port: Port }).parse({
    host,
    port,
  });
  const selectedTransport = ProxyTransport.parse(transport);
  if (selectedTransport === "exec") {
    return await connectExecProxy(ctx, host, port, connect);
  }
  ctx.signal.throwIfAborted();
  const channel = await connect(
    ctx,
    spritePath(ctx, selectedTransport === "control" ? "/control" : "/proxy"),
  );
  try {
    const start = selectedTransport === "control"
      ? `control:${
        JSON.stringify({
          type: "op.start",
          op: "proxy",
          args: { host: target.host, port: String(target.port) },
        })
      }`
      : JSON.stringify(target);
    await channel.send(start);
    const response = await readWithAbort(channel, ctx.signal);
    if (!response) {
      throw new ProxyProtocolError(
        "Sprite TCP proxy disconnected before reporting connected status.",
      );
    }
    if (response.binary) {
      throw new ProxyProtocolError(
        "Sprite TCP proxy returned a binary connection status.",
      );
    }
    let status: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        response.bytes,
      );
      const envelope = text.startsWith("control:");
      status = JSON.parse(envelope ? text.slice("control:".length) : text);
      if (envelope) {
        throw new Error("Expected an ordinary proxy acknowledgement.");
      }
      Connected.parse(status);
    } catch {
      const diagnostic = z.object({
        type: z.string().optional(),
        error: z.string().optional(),
        message: z.string().optional(),
        args: z.object({ error: z.string().optional() }).optional(),
      }).safeParse(status);
      let detail = diagnostic.success
        ? diagnostic.data.args?.error ?? diagnostic.data.error ??
          diagnostic.data.message ?? diagnostic.data.type ?? ""
        : "";
      for (
        const value of [ctx.globalArgs.token, host].sort((a, b) =>
          b.length - a.length
        )
      ) detail = detail.replaceAll(value, "[redacted]");
      detail = detail.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(
        0,
        512,
      );
      throw new ProxyProtocolError(
        `Sprite TCP proxy did not report connected status${
          detail ? `: ${detail}` : "."
        }`,
      );
    }
    return new ChannelDuplex(
      channel,
      selectedTransport === "control",
      (message, properties) => ctx.logger.info(message, properties),
    );
  } catch (error) {
    await channel.close();
    throw error;
  }
}

class ProxyProtocolError extends Error {}

type ProxyChannelDiagnostic = (
  message: string,
  properties: Record<string, unknown>,
) => void;

const ProxyCompletion = z.object({
  type: z.literal("op.complete"),
  op: z.literal("proxy").optional(),
});

function isProxyCompletion(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.startsWith("control:") &&
      ProxyCompletion.safeParse(JSON.parse(text.slice("control:".length)))
        .success;
  } catch {
    return false;
  }
}

class ChannelDuplex extends Duplex {
  #reading = false;
  #closed = false;
  #binaryFrameCount = 0;
  #binaryBytes = 0;
  #emptyBinaryFrames = 0;

  constructor(
    private readonly channel: Channel,
    private readonly control: boolean,
    private readonly diagnostic?: ProxyChannelDiagnostic,
  ) {
    super({ allowHalfOpen: false });
  }

  #report(message: string, properties: Record<string, unknown>): void {
    try {
      this.diagnostic?.(message, {
        binaryFrameCount: this.#binaryFrameCount,
        binaryBytes: this.#binaryBytes,
        emptyBinaryFrames: this.#emptyBinaryFrames,
        ...properties,
      });
    } catch {
      // Diagnostics must not alter stream lifecycle behavior.
    }
  }

  override _read(): void {
    if (this.#reading || this.#closed) return;
    this.#reading = true;
    this.#pump().catch((error) =>
      this.destroy(
        error instanceof Error
          ? error
          : new Error("Sprite TCP proxy receive failed."),
      )
    );
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#closed) {
        const message = await this.channel.read();
        if (this.#closed) return;
        if (!message) {
          const closeCode = this.channel.closeCode();
          this.#closed = true;
          if (closeCode !== undefined && closeCode !== 1000) {
            this.#report("TCP proxy channel closed prematurely", {
              remoteEof: "websocket-close",
              socketCloseCode: closeCode,
            });
            throw new ProxyProtocolError(
              `Sprite TCP proxy WebSocket closed abnormally with code ${closeCode}.`,
            );
          }
          this.push(null);
          this.#report("TCP proxy channel reached remote EOF", {
            remoteEof: "websocket-close",
            socketCloseCode: closeCode,
          });
          return;
        }
        if (!message.binary) {
          if (this.control && isProxyCompletion(message.bytes)) {
            this.#closed = true;
            // Make remote EOF visible before waiting for WebSocket teardown.
            this.push(null);
            await this.channel.close();
            this.#report("TCP proxy channel reached remote EOF", {
              remoteEof: "control-complete",
              socketCloseCode: this.channel.closeCode(),
            });
            return;
          }
          throw new ProxyProtocolError(
            "Sprite TCP proxy returned a text frame after connecting.",
          );
        }
        this.#binaryFrameCount += 1;
        this.#binaryBytes += message.bytes.length;
        if (message.bytes.length === 0) {
          this.#emptyBinaryFrames += 1;
          continue;
        }
        if (!this.push(Buffer.from(message.bytes))) return;
      }
    } finally {
      this.#reading = false;
    }
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.channel.send(new Uint8Array(chunk)).then(
      () => callback(),
      () => callback(new Error("Sprite TCP proxy send failed.")),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#closed = true;
    this.#report("TCP proxy channel received local end", {
      cleanupCause: "local-end",
      socketCloseCode: this.channel.closeCode(),
    });
    Promise.resolve(this.channel.close()).then(
      () => callback(),
      () => callback(new Error("Sprite proxy close failed.")),
    );
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#closed = true;
    const cleanupCause = error
      ? error instanceof ProxyProtocolError ? "protocol-error" : "stream-error"
      : "normal";
    Promise.resolve(this.channel.close()).then(
      () => {
        this.#report("TCP proxy channel cleanup finished", {
          cleanupCause,
          socketCloseCode: this.channel.closeCode(),
        });
        callback(error);
      },
      () => {
        this.#report("TCP proxy channel cleanup failed", {
          cleanupCause,
          socketCloseCode: this.channel.closeCode(),
        });
        callback(error ?? new Error("Sprite proxy close failed."));
      },
    );
  }
}

/** Dependencies used by the loopback listener, exposed for deterministic tests. */
export type ProxyDependencies = {
  connect?: ConnectChannel;
  createServer?: typeof net.createServer;
};

/** Own a loopback listener and every accepted socket within one global timeout budget. */
export async function runProxy(
  ctx: SpriteContext,
  input: z.input<typeof ProxyArgs>,
  dependencies: ProxyDependencies = {},
): Promise<z.output<typeof ProxyOutput>> {
  const args = ProxyArgs.parse(input);
  ctx.signal.throwIfAborted();
  const globalDeadline = performance.now() + ctx.globalArgs.timeoutMs;
  // WebSocket frames also occupy Node buffers, so queued payloads alone stay
  // within 128 MiB across the configured connection cap.
  const connectionQueueBytes = Math.min(
    ctx.globalArgs.maxResponseBytes,
    MAX_PROXY_QUEUE_BYTES,
    Math.floor(MAX_PROXY_AGGREGATE_QUEUE_BYTES / args.maxConnections),
  );
  const timeout = new AbortController();
  const timeoutError = new Error("TCP proxy exceeded timeoutMs.");
  const timeoutTimer = setTimeout(
    () => timeout.abort(timeoutError),
    ctx.globalArgs.timeoutMs,
  );
  const lifetime = new AbortController();
  const sessionContext = {
    ...ctx,
    signal: AbortSignal.any([
      ctx.signal,
      timeout.signal,
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
    const acceptedAt = performance.now();
    const remainingTimeoutMs = Math.floor(globalDeadline - acceptedAt);
    const connectionLifetime = new AbortController();
    const connectionSignal = AbortSignal.any([
      sessionContext.signal,
      connectionLifetime.signal,
    ]);
    let phase: "pending" | "established" = "pending";
    let tunnel: Duplex | undefined;
    let socketClosed = false;
    let socketFailed = false;
    let localEnded = false;
    let remoteEnded = false;
    let cleanupCause = "connection-cleanup";
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
      cleanupCause = "client-error";
      connectionLifetime.abort(error);
      finishConnection({ kind: "error", error });
    };
    const onSocketClose = (): void => {
      socketClosed = true;
      if (!connectionLifetime.signal.aborted) {
        connectionLifetime.abort(new Error("Loopback TCP client closed."));
      }
      if (socketFailed) return;
      cleanupCause = remoteEnded ? "clean-remote-eof" : "client-close";
      finishConnection({
        kind: remoteEnded ? "clean-remote-eof" : "client-close",
      });
    };
    const onSocketEnd = (): void => {
      localEnded = true;
      if (phase === "pending") socket.destroy();
    };
    // Install these before starting the remote handshake: paused sockets can
    // still close or emit an error before connectProxy resolves.
    socket.once("error", onSocketError);
    socket.once("close", onSocketClose);
    socket.once("end", onSocketEnd);
    socket.read(0);

    const task = (async (): Promise<void> => {
      let onTunnelData: ((chunk: Buffer) => void) | undefined;
      let onTunnelEnd: (() => void) | undefined;
      let onTunnelClose: (() => void) | undefined;
      let onTunnelError: ((error: Error) => void) | undefined;
      try {
        try {
          if (remainingTimeoutMs <= 0) {
            if (!timeout.signal.aborted) timeout.abort(timeoutError);
            throw timeoutError;
          }
          tunnel = await connectProxy(
            {
              ...sessionContext,
              signal: connectionSignal,
              globalArgs: {
                ...sessionContext.globalArgs,
                timeoutMs: remainingTimeoutMs,
                maxResponseBytes: connectionQueueBytes,
              },
            },
            args.host,
            args.port,
            connect,
            args.transport,
          );
        } catch (error) {
          if (
            socketClosed && !socketFailed &&
            !sessionContext.signal.aborted
          ) {
            cleanupCause = "client-close-during-handshake";
            return;
          }
          cleanupCause = "handshake-error";
          throw error;
        }
        phase = "established";
        onTunnelData = (chunk: Buffer): void => {
          bytesFromRemote += chunk.length;
        };
        onTunnelEnd = (): void => {
          remoteEnded = true;
          cleanupCause = "remote-eof-draining-local-socket";
          if (socketClosed) {
            finishConnection({ kind: "clean-remote-eof" });
          }
        };
        onTunnelClose = (): void => {
          if (remoteEnded || socketClosed || outcome) return;
          cleanupCause = "premature-tunnel-close";
          finishConnection({
            kind: "error",
            error: new ProxyProtocolError(
              "Sprite TCP proxy tunnel closed before remote EOF.",
            ),
          });
        };
        onTunnelError = (error: Error): void => {
          cleanupCause = error instanceof ProxyProtocolError
            ? "protocol-error"
            : "tunnel-error";
          finishConnection({ kind: "error", error });
        };
        tunnel.on("data", onTunnelData);
        tunnel.once("end", onTunnelEnd);
        tunnel.once("close", onTunnelClose);
        tunnel.once("error", onTunnelError);
        socket.on("data", (chunk: Buffer) => {
          bytesFromClients += chunk.length;
        });
        if (socketClosed) return;
        socket.pipe(tunnel).pipe(socket);
        socket.resume();
        const result = await connectionDone;
        if (result.kind === "error") {
          throw result.error instanceof ProxyProtocolError
            ? result.error
            : new Error("A loopback TCP proxy connection failed.");
        }
      } finally {
        socket.off("error", onSocketError);
        socket.off("close", onSocketClose);
        socket.off("end", onSocketEnd);
        if (tunnel) {
          if (onTunnelData) tunnel.off("data", onTunnelData);
          if (onTunnelEnd) tunnel.off("end", onTunnelEnd);
          if (onTunnelClose) tunnel.off("close", onTunnelClose);
          if (onTunnelError) tunnel.off("error", onTunnelError);
        }
        socket.destroy();
        tunnel?.destroy();
        sockets.delete(socket);
        completedConnections += 1;
        ctx.logger.info("TCP proxy connection cleanup finished", {
          phase,
          cleanupCause,
          localEnd: localEnded,
          remoteEof: remoteEnded,
          socketClosed,
        });
      }
    })();
    tasks.add(task);
    task.catch((error) => {
      if (durationEnded && phase === "established") return;
      fail(
        error === timeoutError
          ? timeoutError.message
          : error instanceof ProxyProtocolError
          ? error.message
          : "A loopback TCP proxy connection failed.",
      );
    }).finally(() => tasks.delete(task));
  });

  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = (): void => fail("TCP proxy was cancelled.");
  const onTimeout = (): void => fail(timeoutError.message);
  const onServerError = (): void =>
    fail("The loopback TCP proxy listener failed.");
  const onBindError = (): void =>
    fail("Could not bind the loopback TCP proxy listener.");
  const checkGlobalDeadline = (): void => {
    if (performance.now() >= globalDeadline && !timeout.signal.aborted) {
      timeout.abort(timeoutError);
    }
  };
  ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  timeout.signal.addEventListener("abort", onTimeout, { once: true });
  if (ctx.signal.aborted) onParentAbort();
  if (timeout.signal.aborted) onTimeout();
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
    clearTimeout(timeoutTimer);
    ctx.signal.removeEventListener("abort", onParentAbort);
    timeout.signal.removeEventListener("abort", onTimeout);
  }
  checkGlobalDeadline();
  if (firstFailure) throw firstFailure;
  ctx.signal.throwIfAborted();
  timeout.signal.throwIfAborted();
  return ProxyOutput.parse({
    localAddress: "127.0.0.1",
    localPort: args.localPort,
    remoteHost: args.host,
    remotePort: args.port,
    transport: args.transport,
    acceptedConnections,
    completedConnections,
    rejectedConnections,
    bytesFromClients,
    bytesFromRemote,
    durationMs: args.durationMs,
    closed: true,
  });
}

/** Streaming resources for composition into the single-Sprite model. */
export const streamingResources = {
  watchEvents: resource(
    WatchOutput,
    "Bounded filesystem watch events; never an exhaustive history",
    "7d",
  ),
  proxy: resource(ProxyOutput, "Closed loopback TCP proxy observation", "7d"),
};

/** Streaming methods for composition into the single-Sprite model. */
export const streamingMethods = {
  watch: {
    description:
      "Observe acknowledged Sprite filesystem events for a bounded duration",
    arguments: WatchArgs,
    execute: async (
      input: z.input<typeof WatchArgs>,
      ctx: SpriteContext,
    ): Promise<Result> => {
      ctx.logger.info("Starting filesystem watch");
      const output = await observeWatch(ctx, input);
      ctx.signal.throwIfAborted();
      const handle = await ctx.writeResource(
        "watchEvents",
        "watchEvents",
        output,
      );
      ctx.logger.info("Finished filesystem watch");
      return { dataHandles: [handle] };
    },
  },
  proxy: {
    description: "Run a bounded loopback-only TCP proxy through the Sprite",
    arguments: ProxyArgs,
    execute: async (
      input: z.input<typeof ProxyArgs>,
      ctx: SpriteContext,
    ): Promise<Result> => {
      ctx.logger.info("Starting TCP proxy");
      const output = await runProxy(ctx, input);
      ctx.signal.throwIfAborted();
      const handle = await ctx.writeResource("proxy", "proxy", output);
      ctx.logger.info("Finished TCP proxy");
      return { dataHandles: [handle] };
    },
  },
};
