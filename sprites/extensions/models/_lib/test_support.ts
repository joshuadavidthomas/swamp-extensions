// SPDX-License-Identifier: MIT
import { createModelTestContext } from "@swamp-club/swamp-testing";
import type { Auth, Context } from "./core.ts";
import type { Channel, Message } from "./socket.ts";

export class FakeChannel implements Channel {
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  reads = 0;
  #messages: Array<Message | null | Error>;
  #waiters: Array<(message: Message | null) => void> = [];
  #closing: Promise<void> | undefined;
  #ended = false;
  constructor(
    messages: Array<Message | null | Error>,
    private readonly onClose?: () => Promise<void>,
  ) {
    this.#messages = [...messages];
  }
  read(): Promise<Message | null> {
    this.reads++;
    if (this.closed || this.#ended) return Promise.resolve(null);
    if (this.#messages.length) {
      const next = this.#messages.shift() ?? null;
      if (next === null || next instanceof Error) this.#ended = true;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  send(value: string | Uint8Array): Promise<void> {
    if (this.closed || this.#ended) {
      return Promise.reject(new Error("Channel is closed."));
    }
    this.sent.push(value);
    return Promise.resolve();
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.closed = true;
      this.#messages.length = 0;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
      this.#closing = this.onClose?.() ?? Promise.resolve();
    }
    return this.#closing;
  }
}

/** Typed model context with captured writes, logs, and events. */
export function testContext<G extends Auth>(
  globalArgs: G,
  options: Pick<
    NonNullable<Parameters<typeof createModelTestContext>[0]>,
    "signal" | "storedResources"
  > = {},
): Context<G> & Omit<ReturnType<typeof createModelTestContext>, "context"> {
  const { context, ...accessors } = createModelTestContext({
    globalArgs,
    ...options,
  });
  return {
    ...context,
    ...accessors,
    globalArgs,
    signal: options.signal ?? context.signal,
    deleteResource: () => Promise.resolve(),
  };
}

export function textFrame(value: unknown): Message {
  return {
    binary: false,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}

export function binaryFrame(...bytes: number[]): Message {
  return { binary: true, bytes: new Uint8Array(bytes) };
}
