// SPDX-License-Identifier: MIT
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { type Auth, type Context } from "./core.ts";
import { type Channel, type Message } from "./socket.ts";
import { assertEquals } from "jsr:@std/assert@1.0.14";
import { type SpriteContext } from "./sprite.ts";
import { model as spriteModel } from "../sprite.ts";

const routeMethods = spriteModel.methods;
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
): Context<G> & Omit<ReturnType<typeof createModelTestContext>, "context"> & {
  getDeletedResources(): string[];
} {
  const deleted: string[] = [];
  const { context, ...accessors } = createModelTestContext({
    globalArgs,
    ...options,
  });
  return {
    ...context,
    ...accessors,
    globalArgs,
    signal: options.signal ?? context.signal,
    deleteResource: (spec) => {
      deleted.push(spec);
      return Promise.resolve();
    },
    getDeletedResources: () => [...deleted],
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

export const globalArgs = {
  token: "test-token",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
};
export const childArgs = {
  token: globalArgs.token,
  baseUrl: globalArgs.baseUrl,
  timeoutMs: globalArgs.timeoutMs,
  maxResponseBytes: globalArgs.maxResponseBytes,
  sprite: globalArgs.name,
};
export const sprite = {
  id: "sprite-1",
  name: "demo sprite",
  organization: "acme",
  url: "https://demo.sprites.app",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

export type Runnable = {
  execute(
    input: unknown,
    ctx: SpriteContext,
  ): Promise<{ dataHandles: Array<{ name: string }> }>;
};
export function runnable(name: keyof typeof routeMethods): Runnable {
  return routeMethods[name] as unknown as Runnable;
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
  });
}
export function ndjson(value: string): Response {
  return new Response(value);
}
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export type RouteCase = {
  name: Parameters<typeof runnable>[0];
  args: unknown;
  httpMethod: string;
  path: string;
  response: Response;
  verifies?: boolean;
  output?: string;
};

export function registerRouteCases(routeCases: RouteCase[]): void {
  Deno.test("every JSON and NDJSON REST method uses its provider route and writes validated output", async () => {
    for (const testCase of routeCases) {
      const context = testContext(globalArgs, {
        storedResources: testCase.name === "create" ? {} : { state: sprite },
      });
      const responses = testCase.verifies
        ? [json(sprite), testCase.response]
        : [testCase.response];
      const { calls } = await withMockedFetch(
        responses,
        () => runnable(testCase.name).execute(testCase.args, context),
      );
      const target = calls.at(-1);
      assertEquals(target?.method, testCase.httpMethod, testCase.name);
      assertEquals(
        target?.url,
        `https://api.sprites.dev${testCase.path}`,
        testCase.name,
      );
      assertEquals(
        target?.headers.authorization,
        "Bearer test-token",
        testCase.name,
      );
      if (testCase.verifies) {
        assertEquals(
          calls[0].method,
          "GET",
          `${testCase.name} preflight method`,
        );
        assertEquals(
          calls[0].url,
          "https://api.sprites.dev/v1/sprites/demo%20sprite",
          `${testCase.name} preflight URL`,
        );
      }
      assertEquals(
        context.getWrittenResources().at(-1)?.specName,
        testCase.output,
        testCase.name,
      );
    }
  });
}

export const observationGlobalArgs = {
  token: "test",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
};
