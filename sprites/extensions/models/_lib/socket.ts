// SPDX-License-Identifier: MIT
/** Authenticated, cancellable WebSocket transport with bounded receive queues. @module */
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket from "ws";
import { Buffer } from "node:buffer";
import { apiUrl, type Context, type Query } from "./core.ts";

const MAX_QUEUED_MESSAGES = 1_024;

/** Preserve the distinction between JSON control and binary data frames. */
export type Message = { binary: boolean; bytes: Uint8Array };
/** An owned WebSocket connection. Call close in a finally block. */
export type Channel = {
  read(): Promise<Message | null>;
  send(data: string | Uint8Array): Promise<void>;
  close(): void | Promise<void>;
  closeCode(): number | undefined;
};
/** Socket construction boundary for transport integration tests. */
export type SocketFactory = (
  url: URL,
  options: WebSocket.ClientOptions,
) => WebSocket;
/** Connect with a bearer header; credentials never enter the URL or error text. */
export async function openChannel(
  ctx: Pick<Context, "globalArgs" | "signal">,
  path: string,
  query: Query = {},
  createSocket: SocketFactory = (url, options) => new WebSocket(url, options),
): Promise<Channel> {
  const signal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(ctx.globalArgs.timeoutMs),
  ]);
  signal.throwIfAborted();
  const url = apiUrl(ctx.globalArgs, path, query);
  url.protocol = "wss:";
  const ws = createSocket(url, {
    headers: { authorization: `Bearer ${ctx.globalArgs.token}` },
    followRedirects: false,
    maxPayload: ctx.globalArgs.maxResponseBytes,
    handshakeTimeout: ctx.globalArgs.timeoutMs,
  });
  const queue: Message[] = [];
  let queueBytes = 0;
  let finished = false;
  let code: number | undefined;
  let failure: Error | undefined;
  let drainQueueBeforeFailure = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const callback = wake;
    wake = undefined;
    callback?.();
  };
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    signal.removeEventListener("abort", onAbort);
    finished = true;
    notify();
    closing = new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        ws.terminate();
      }, 500);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "");
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    });
    return closing;
  };
  const fail = (error: Error, drainQueue = false): void => {
    if (failure) return;
    failure = error;
    drainQueueBeforeFailure = drainQueue;
    if (!drainQueue) {
      queue.length = 0;
      queueBytes = 0;
    }
    finished = true;
    notify();
    ws.terminate();
  };
  const onAbort = (): void => {
    failure = new Error(
      "Sprites WebSocket operation was cancelled or exceeded timeoutMs.",
    );
    drainQueueBeforeFailure = false;
    queue.length = 0;
    queueBytes = 0;
    void shutdown();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  ws.on("message", (data, binary) => {
    if (finished) return;
    const bytes = Array.isArray(data)
      ? new Uint8Array(Buffer.concat(data))
      : new Uint8Array(data);
    queueBytes += bytes.length;
    if (
      queueBytes > ctx.globalArgs.maxResponseBytes ||
      queue.length >= MAX_QUEUED_MESSAGES
    ) {
      fail(
        new Error(
          queueBytes > ctx.globalArgs.maxResponseBytes
            ? "Sprites WebSocket receive queue exceeded maxResponseBytes."
            : "Sprites WebSocket receive queue exceeded its frame limit.",
        ),
      );
      return;
    }
    queue.push({ binary, bytes });
    notify();
  });
  ws.on(
    "error",
    () =>
      fail(
        new Error(
          "Sprites WebSocket connection failed; inspect the remote operation before retrying.",
        ),
        true,
      ),
  );
  ws.on("close", (value) => {
    finished = true;
    code = value;
    signal.removeEventListener("abort", onAbort);
    notify();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(
          failure ??
            new Error("Sprites WebSocket closed during its handshake."),
        );
      };
      const cleanup = (): void => {
        ws.off("open", onOpen);
        ws.off("close", onClose);
      };
      ws.once("open", onOpen);
      ws.once("close", onClose);
      if (signal.aborted) onAbort();
    });
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    ws.terminate();
    throw error;
  }
  return {
    async read(): Promise<Message | null> {
      while (!queue.length && !finished) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure && (!drainQueueBeforeFailure || queue.length === 0)) {
        throw failure;
      }
      const next = queue.shift();
      if (next) queueBytes -= next.bytes.length;
      return next ?? null;
    },
    async send(data): Promise<void> {
      if (finished || ws.readyState !== WebSocket.OPEN) {
        throw failure ?? new Error("Sprites WebSocket is closed.");
      }
      await new Promise<void>((resolve, reject) =>
        ws.send(
          data,
          (error) =>
            error
              ? reject(new Error("Sprites WebSocket send failed."))
              : resolve(),
        )
      );
    },
    close: shutdown,
    closeCode(): number | undefined {
      return code;
    },
  };
}

/** Dependency boundary for authenticated Sprite WebSocket channels. */
export type ConnectChannel = typeof openChannel;

export async function readChannel(
  channel: Channel,
  signal: AbortSignal,
  operation: string,
): Promise<Message | null> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error(`${operation} was cancelled.`));
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
