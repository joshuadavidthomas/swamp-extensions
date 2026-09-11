// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import type { Channel, Message } from "./socket.ts";
import type { SpriteContext } from "./sprite-api.ts";
import { connectExecProxy } from "./exec-proxy.ts";

const encoder = new TextEncoder();
const globalArgs = {
  token: "top-secret-token",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
};
const sprite = {
  id: "sprite-id",
  name: "demo sprite",
  organization: "org",
  url: "https://demo.example",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  url_settings: null,
  version: null,
  environment_version: null,
};

function context(
  signal = new AbortController().signal,
  overrides: Partial<SpriteContext["globalArgs"]> = {},
): SpriteContext {
  const args = { ...globalArgs, ...overrides };
  const { context } = createModelTestContext({ globalArgs: args });
  return {
    ...context,
    globalArgs: args,
    signal,
    readResource: () => Promise.resolve({ id: sprite.id }),
    deleteResource: () => Promise.resolve(),
  };
}
function binary(stream: number, bytes: number[] = []): Message {
  return { binary: true, bytes: new Uint8Array([stream, ...bytes]) };
}
function control(value: unknown): Message {
  return { binary: false, bytes: encoder.encode(JSON.stringify(value)) };
}

class FakeChannel implements Channel {
  sent: Array<string | Uint8Array> = [];
  closed = false;
  reads = 0;
  #messages: Array<Message | null>;
  #waiters: Array<(message: Message | null) => void> = [];
  #closing: Promise<void> | undefined;

  constructor(messages: Array<Message | null>) {
    this.#messages = [...messages];
  }
  read(): Promise<Message | null> {
    this.reads++;
    if (this.#messages.length) {
      return Promise.resolve(this.#messages.shift() ?? null);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  send(value: string | Uint8Array): Promise<void> {
    this.sent.push(value);
    return Promise.resolve();
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
      this.#closing = Promise.resolve();
    }
    return this.#closing;
  }
  closeCode(): number | undefined {
    return this.closed ? 1000 : undefined;
  }
}

async function verified<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(sprite), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("exec relay uses fixed argv, split ack, and queues raw stdout", async () => {
  const channel = new FakeChannel([
    control({ type: "session_info", session_id: "session", tty: false }),
    control({ type: "port_opened", port: 5432 }),
    binary(1, [0, 255, 8]),
    binary(2, Array.from(encoder.encode("conn"))),
    control({ type: "debug", message: "starting" }),
    binary(2, Array.from(encoder.encode("ected\n"))),
    control({ type: "port_closed", port: 5432 }),
    binary(1, [7, 6]),
    binary(3, [0]),
  ]);
  let query: Record<string, unknown> | undefined;
  const stream = await verified(() =>
    connectExecProxy(context(), "db.internal", 5432, (_ctx, path, value) => {
      assertEquals(path, "/v1/sprites/demo%20sprite/exec");
      query = value;
      return Promise.resolve(channel);
    })
  );
  const argv = query!.cmd as string[];
  assertEquals(argv.slice(0, 4), [
    "/.sprite/bin/python3",
    "-I",
    "-u",
    "-c",
  ]);
  assertStringIncludes(argv[4], "data=os.read(0,65536)");
  assertEquals(argv[4].includes("sys.stdin.buffer.read"), false);
  assertStringIncludes(argv[4], "threading.Timer(float(sys.argv[3])");
  assertEquals(argv.slice(-3, -1), ["db.internal", "5432"]);
  const remainingSeconds = Number(argv.at(-1));
  assertEquals(Number.isFinite(remainingSeconds), true);
  assertEquals(remainingSeconds > 0, true);
  assertEquals(remainingSeconds <= globalArgs.timeoutMs / 1_000, true);
  assertEquals(argv.join(" ").includes(globalArgs.token), false);
  assertEquals(query!.stdin, true);
  assertEquals(query!.tty, false);
  assertEquals(query!.max_run_after_disconnect, "1s");
  const received: number[] = [];
  for await (const chunk of stream) received.push(...chunk);
  assertEquals(received, [0, 255, 8, 7, 6]);
  assertEquals(channel.closed, true);
});

Deno.test("exec relay frames stdin bytes and sends EOF without closing the channel", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const stream = await verified(() =>
    connectExecProxy(context(), "service", 80, () => Promise.resolve(channel))
  );
  await new Promise<void>((resolve, reject) =>
    stream.write(
      new Uint8Array([0, 255, 4]),
      (error) => error ? reject(error) : resolve(),
    )
  );
  await new Promise<void>((resolve, reject) =>
    stream.end((error?: Error | null) => error ? reject(error) : resolve())
  );
  assertEquals(Array.from(channel.sent[0] as Uint8Array), [0, 0, 255, 4]);
  assertEquals(Array.from(channel.sent[1] as Uint8Array), [4]);
  assertEquals(channel.closed, false);
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.destroy();
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("exec relay rejects a connection failure before acknowledgement", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("relay failed\n"))),
  ]);
  await assertRejects(
    () =>
      verified(() =>
        connectExecProxy(
          context(),
          "missing",
          9,
          () => Promise.resolve(channel),
        )
      ),
    Error,
    "did not receive",
  );
  assertEquals(channel.sent, [
    JSON.stringify({ type: "signal", signal: "SIGTERM" }),
  ]);
  assertEquals(channel.closed, true);
});

Deno.test("exec relay reports nonzero native binary exit as an error", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    binary(3, [124]),
  ]);
  const stream = await verified(() =>
    connectExecProxy(context(), "service", 80, () => Promise.resolve(channel))
  );
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.resume();
  assertStringIncludes((await failed).message, "code 124");
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("exec relay accepts the native JSON exit code", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    control({ type: "port_opened", port: 1234 }),
    control({ type: "port_closed", port: 1234 }),
    control({ type: "exit", exit_code: 0 }),
  ]);
  const stream = await verified(() =>
    connectExecProxy(context(), "service", 80, () => Promise.resolve(channel))
  );
  const output: number[] = [];
  for await (const chunk of stream) output.push(...chunk);
  assertEquals(output, []);
  assertEquals(channel.closed, true);
});

Deno.test("exec relay treats WebSocket close without exit as an error", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    null,
  ]);
  const stream = await verified(() =>
    connectExecProxy(context(), "service", 80, () => Promise.resolve(channel))
  );
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.resume();
  assertStringIncludes((await failed).message, "without an exit frame");
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("destroy signals the owned remote exec and closes its channel", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const stream = await verified(() =>
    connectExecProxy(context(), "service", 80, () => Promise.resolve(channel))
  );
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.destroy();
  await closed;
  assertEquals(channel.sent, [
    JSON.stringify({ type: "signal", signal: "SIGTERM" }),
  ]);
  assertEquals(channel.closed, true);
});

Deno.test("parent cancellation destroys an established relay", async () => {
  const abort = new AbortController();
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const stream = await verified(() =>
    connectExecProxy(
      context(abort.signal),
      "service",
      80,
      () => Promise.resolve(channel),
    )
  );
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.resume();
  abort.abort();
  assertStringIncludes((await failed).message, "cancelled");
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("exec relay enforces its monotonic deadline while control frames stay queued", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const originalRead = channel.read.bind(channel);
  channel.read = () => {
    if (channel.reads === 0) return originalRead();
    channel.reads++;
    return Promise.resolve(control({ type: "debug", message: "queued" }));
  };
  const stream = await verified(() =>
    connectExecProxy(
      context(undefined, { timeoutMs: 1 }),
      "service",
      80,
      () => Promise.resolve(channel),
    )
  );
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  stream.resume();
  assertStringIncludes((await failed).message, "timeoutMs");
  assertEquals(channel.reads < 100_000, true);
  assertEquals(channel.closed, true);
});

Deno.test("exec relay stops channel reads when its consumer backpressures", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    binary(1, Array(100_000).fill(1)),
    binary(1, Array(100_000).fill(2)),
  ]);
  const stream = await verified(() =>
    connectExecProxy(context(), "service", 80, () => Promise.resolve(channel))
  );
  try {
    stream.read(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(channel.reads, 2);
    assertEquals(stream.readableLength, 100_000);
  } finally {
    stream.destroy();
  }
});
