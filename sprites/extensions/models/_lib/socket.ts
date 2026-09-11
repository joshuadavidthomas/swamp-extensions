// SPDX-License-Identifier: MIT
/** Authenticated, cancellable WebSocket transport with bounded receive queues. @module */
import WebSocket from "ws";
import { Buffer } from "node:buffer";
import {
  apiUrl,
  type Context,
  deadline,
  decodeFrame,
  type Query,
} from "./core.ts";
import { z } from "zod";
import { type SpriteContext, spritePath } from "./sprite.ts";

// @deno-types="npm:@types/ws@8.18.1"

const MAX_QUEUED_MESSAGES = 1_024;

/** Preserve the distinction between JSON control and binary data frames. */
export type Message = { binary: boolean; bytes: Uint8Array };
/** An owned WebSocket connection. Call close in a finally block. */
export type Channel = {
  read(): Promise<Message | null>;
  send(data: string | Uint8Array): Promise<void>;
  close(): void | Promise<void>;
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
  ws.on("close", () => {
    finished = true;
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
  };
}

/** Dependency boundary for authenticated Sprite WebSocket channels. */
export type ConnectChannel = typeof openChannel;

export async function readChannel(
  channel: Channel,
  signal: AbortSignal,
): Promise<Message | null> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
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
  });
}

const STOP = Symbol("observation duration elapsed");

type Observation<F, E, T> = {
  connect: ConnectChannel;
  path: string;
  subscribe?: string;
  first: (bytes: Uint8Array) => F;
  eventSchema: z.ZodType<E>;
  event: (value: E) => T;
  operation: string;
  cap: number;
  durationMs: number;
};

export async function observeChannel<F, E, T>(
  ctx: SpriteContext,
  options: Observation<F, E, T>,
): Promise<{ first: F; events: T[] }> {
  const budget = deadline(ctx);
  const { signal } = budget;
  let channel: Channel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    ctx.signal.throwIfAborted();
    budget.check(`${options.operation} exceeded timeoutMs.`);
  };
  try {
    check();
    channel = await options.connect(
      { ...ctx, signal },
      spritePath(ctx.globalArgs.name, options.path),
    );
    check();
    if (options.subscribe !== undefined) {
      await channel.send(options.subscribe);
      check();
    }
    let receivedBytes = 0;
    const read = async () => {
      const message = await readChannel(channel!, signal);
      if (message) {
        receivedBytes += message.bytes.length;
        if (receivedBytes > ctx.globalArgs.maxResponseBytes) {
          throw new Error(
            `${options.operation} exceeded maxResponseBytes; no result was saved.`,
          );
        }
      }
      return message;
    };
    const initial = await read();
    check();
    if (!initial) {
      throw new Error(
        `${options.operation} disconnected before its first message.`,
      );
    }
    if (initial.binary) {
      throw new Error(
        `${options.operation} returned an unexpected binary frame.`,
      );
    }
    const first = options.first(initial.bytes);
    const stopped = new Promise<typeof STOP>((resolve) => {
      timer = setTimeout(() => resolve(STOP), options.durationMs);
    });
    const events: T[] = [];
    while (events.length < options.cap) {
      check();
      const next = await Promise.race([read(), stopped]);
      check();
      if (next === STOP) break;
      if (!next) {
        throw new Error(
          `${options.operation} disconnected before its bounded observation ended.`,
        );
      }
      if (next.binary) {
        throw new Error(
          `${options.operation} returned an unexpected binary frame.`,
        );
      }
      events.push(options.event(decodeFrame(
        next.bytes,
        options.eventSchema,
        `${options.operation} returned an invalid event.`,
      )));
    }
    return { first, events };
  } catch (error) {
    check();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    budget.dispose();
    await channel?.close();
  }
}
