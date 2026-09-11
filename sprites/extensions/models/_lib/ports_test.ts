// SPDX-License-Identifier: MIT
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import type { Channel, Message } from "./socket.ts";
import type { SpriteContext } from "./sprite-api.ts";
import { portMethods, portResources, watchPorts } from "./ports.ts";

const encoder = new TextEncoder();
const globalArgs = {
  token: "test-token",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
};

function context(
  signal = new AbortController().signal,
  overrides: Partial<typeof globalArgs> = {},
): SpriteContext {
  const args = { ...globalArgs, ...overrides };
  const { context } = createModelTestContext({ globalArgs: args });
  return {
    ...context,
    globalArgs: args,
    signal,
    deleteResource: () => Promise.resolve(),
  };
}

function text(value: unknown): Message {
  return { binary: false, bytes: encoder.encode(JSON.stringify(value)) };
}

class FakeChannel implements Channel {
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  reads = 0;
  #messages: Array<Message | null | Error>;
  #waiters: Array<(value: Message | null) => void> = [];

  constructor(messages: Array<Message | null | Error>) {
    this.#messages = [...messages];
  }

  read(): Promise<Message | null> {
    this.reads++;
    if (this.#messages.length) {
      const next = this.#messages.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next ?? null);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  send(data: string | Uint8Array): Promise<void> {
    this.sent.push(data);
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.#waiters.splice(0)) resolve(null);
  }

  closeCode(): number | undefined {
    return undefined;
  }
}

const opened = {
  type: "port_opened" as const,
  port: 3000,
  address: "https://demo.sprites.dev:3000",
  pid: 1847,
};
const closed = {
  type: "port_closed" as const,
  port: 3000,
  address: "https://demo.sprites.dev:3000",
  pid: 1847,
};

Deno.test("port watch reads the snapshot and notifications without sending client frames", async () => {
  const channel = new FakeChannel([
    text({ type: "port_list", ports: [opened] }),
    text(closed),
  ]);
  const output = await watchPorts(
    context(),
    { durationMs: 1_000, maxEvents: 1 },
    (_ctx, path, query) => {
      assertEquals(path, "/v1/sprites/demo%20sprite/ports/watch");
      assertEquals(query, undefined);
      return Promise.resolve(channel);
    },
  );
  assertEquals(output, {
    initialPorts: [opened],
    notifications: [closed],
    truncated: true,
  });
  assertEquals(channel.sent, []);
  assertEquals(channel.closed, true);
});

for (const ports of [[], null]) {
  Deno.test(`port watch normalizes ${ports === null ? "null" : "empty"} initial ports`, async () => {
    const channel = new FakeChannel([
      text({ type: "port_list", ports }),
      text(opened),
    ]);
    const output = await watchPorts(
      context(),
      { durationMs: 1_000, maxEvents: 1 },
      () => Promise.resolve(channel),
    );
    assertEquals(output.initialPorts, []);
    assertEquals(output.notifications, [opened]);
    assertEquals(channel.closed, true);
  });
}

Deno.test("port watch requires a valid initial port_list snapshot", async () => {
  const cases: Array<{ name: string; message: Message }> = [
    { name: "notification", message: text(opened) },
    {
      name: "missing ports",
      message: text({ type: "port_list" }),
    },
    {
      name: "invalid port",
      message: text({ type: "port_list", ports: [{ ...opened, port: 0 }] }),
    },
    {
      name: "malformed JSON",
      message: { binary: false, bytes: encoder.encode("{secret") },
    },
    {
      name: "binary",
      message: { binary: true, bytes: encoder.encode("secret") },
    },
    {
      name: "error",
      message: text({ type: "error", message: "secret" }),
    },
  ];
  for (const testCase of cases) {
    const channel = new FakeChannel([testCase.message]);
    const error = await assertRejects(
      () =>
        watchPorts(
          context(),
          { durationMs: 100 },
          () => Promise.resolve(channel),
        ),
      Error,
    );
    assert(
      error.message.includes("initial") || error.message.includes("binary"),
      `${testCase.name}: ${error.message}`,
    );
    assertEquals(error.message.includes("secret"), false);
    assertEquals(channel.closed, true);
  }
});

Deno.test("port watch treats closure before or after the snapshot as failure", async () => {
  for (
    const [name, messages] of [
      ["snapshot", [null]],
      ["observation", [text({ type: "port_list", ports: [] }), null]],
    ] as const
  ) {
    const channel = new FakeChannel([...messages]);
    const error = await assertRejects(
      () =>
        watchPorts(
          context(),
          { durationMs: 100 },
          () => Promise.resolve(channel),
        ),
      Error,
      "disconnected",
    );
    assert(error.message.length < 200, name);
    assertEquals(channel.closed, true, name);
  }
});

Deno.test("port watch rejects binary, malformed, error, and transport notification frames", async () => {
  const cases: Array<{ name: string; next: Message | Error }> = [
    {
      name: "binary",
      next: { binary: true, bytes: encoder.encode("secret") },
    },
    {
      name: "malformed JSON",
      next: { binary: false, bytes: encoder.encode("{secret") },
    },
    {
      name: "error frame",
      next: text({ type: "error", message: "secret" }),
    },
    { name: "transport error", next: new Error("secret transport detail") },
  ];
  for (const testCase of cases) {
    const channel = new FakeChannel([
      text({ type: "port_list", ports: [] }),
      testCase.next,
    ]);
    const error = await assertRejects(
      () =>
        watchPorts(
          context(),
          { durationMs: 100 },
          () => Promise.resolve(channel),
        ),
      Error,
    );
    assertEquals(error.message.includes("secret"), false, testCase.name);
    assertEquals(channel.closed, true, testCase.name);
  }
});

Deno.test("port watch monotonic deadline stops an unbounded resolved queue", async () => {
  const channel = new FakeChannel([
    text({ type: "port_list", ports: [] }),
  ]);
  let first = true;
  channel.read = () => {
    channel.reads++;
    if (first) {
      first = false;
      return Promise.resolve(text({ type: "port_list", ports: [] }));
    }
    return Promise.resolve(text(opened));
  };
  const output = await watchPorts(
    context(undefined, { maxResponseBytes: 1_073_741_824 }),
    { durationMs: 1, maxEvents: 100_000 },
    () => Promise.resolve(channel),
  );
  assert(output.notifications.length < 100_000);
  assert(channel.reads < 100_001);
  assertEquals(channel.closed, true);
});

Deno.test("port watch duration caps a pending observation after its snapshot", async () => {
  const channel = new FakeChannel([
    text({ type: "port_list", ports: [opened] }),
  ]);
  const output = await watchPorts(
    context(),
    { durationMs: 2 },
    () => Promise.resolve(channel),
  );
  assertEquals(output, {
    initialPorts: [opened],
    notifications: [],
    truncated: true,
  });
  assertEquals(channel.closed, true);
});

Deno.test("port watch bounds cumulative bytes across the snapshot and drained frames", async () => {
  const first = text({ type: "port_list", ports: [] });
  const next = text(opened);
  const channel = new FakeChannel([first, next]);
  await assertRejects(
    () =>
      watchPorts(
        context(undefined, {
          maxResponseBytes: first.bytes.length + next.bytes.length - 1,
        }),
        { durationMs: 1_000, maxEvents: 1 },
        () => Promise.resolve(channel),
      ),
    Error,
    "maxResponseBytes",
  );
  assertEquals(channel.closed, true);
});

Deno.test("port watch maxEvents excludes the separately bounded initial snapshot", async () => {
  const channel = new FakeChannel([
    text({ type: "port_list", ports: [opened, closed] }),
    text(opened),
    text(closed),
  ]);
  const output = await watchPorts(
    context(),
    { durationMs: 1_000, maxEvents: 1 },
    () => Promise.resolve(channel),
  );
  assertEquals(output.initialPorts.length, 2);
  assertEquals(output.notifications, [opened]);
  assertEquals(channel.reads, 2);
  assertEquals(channel.closed, true);
});

Deno.test("port watch fails on parent cancellation and closes its pending read", async () => {
  const controller = new AbortController();
  const channel = new FakeChannel([]);
  const pending = watchPorts(
    context(controller.signal),
    { durationMs: 1_000 },
    () => Promise.resolve(channel),
  );
  controller.abort(new Error("parent stopped"));
  await assertRejects(() => pending, Error, "parent stopped");
  assertEquals(channel.closed, true);
});

Deno.test("port watch enforces the global timeout before the first frame", async () => {
  const channel = new FakeChannel([]);
  await assertRejects(
    () =>
      watchPorts(
        context(undefined, { timeoutMs: 2 }),
        { durationMs: 1_000 },
        () => Promise.resolve(channel),
      ),
    Error,
    "timeoutMs",
  );
  assertEquals(channel.closed, true);
});

Deno.test("port declarations retain bounded arguments and finite output history", () => {
  assertEquals(Object.keys(portMethods), ["watchPorts"]);
  assertEquals(Object.keys(portResources), ["portEvents"]);
  assertEquals(portResources.portEvents.lifetime, "7d");
  assertEquals(portResources.portEvents.garbageCollection, 10);
  assertEquals(
    portMethods.watchPorts.arguments.safeParse({ durationMs: 1 }).success,
    true,
  );
  assertEquals(
    portMethods.watchPorts.arguments.safeParse({ durationMs: 2_147_483_648 })
      .success,
    false,
  );
  assertEquals(
    portMethods.watchPorts.arguments.safeParse({
      durationMs: 1,
      maxEvents: 100_001,
    }).success,
    false,
  );
  const nullOutput = portResources.portEvents.schema.safeParse({
    initialPorts: null,
    notifications: [],
    truncated: true,
  });
  assertEquals(nullOutput.success, false);
});
