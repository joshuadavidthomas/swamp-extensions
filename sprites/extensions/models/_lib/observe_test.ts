// SPDX-License-Identifier: MIT
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import type { Message } from "./socket.ts";
import { type SpriteContext } from "./sprite-api.ts";
import { observeWatch, watchPorts } from "./observe.ts";
import { FakeChannel } from "./test_support.ts";

const encoder = new TextEncoder();
const globalArgs = {
  token: "test",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
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
    deleteResource: () => Promise.resolve(),
  };
}
function text(value: unknown): Message {
  return { binary: false, bytes: encoder.encode(JSON.stringify(value)) };
}

Deno.test("watch reports bounded provider errors with the bearer token removed", async () => {
  const channel = new FakeChannel([
    text({
      type: "error",
      message: `failed for ${globalArgs.token}\n\u2028\u202e${
        "x".repeat(1000)
      }`,
    }),
  ]);
  const error = await assertRejects(
    () =>
      observeWatch(
        context(),
        { paths: ["."], durationMs: 100 },
        () => Promise.resolve(channel),
      ),
    Error,
  );
  assertStringIncludes(error.message, "[redacted]");
  assertEquals(error.message.includes(globalArgs.token), false);
  assertEquals(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(error.message), false);
  assertEquals(error.message.length < 600, true);
  assertEquals(channel.closed, true);
});

Deno.test("watch bounds cumulative received bytes even when its queue drains", async () => {
  const channel = new FakeChannel([
    text({ type: "subscribed" }),
    text({ type: "event", path: "first-long-path", event: "write" }),
    text({ type: "event", path: "second-long-path", event: "write" }),
  ]);
  const ctx = {
    ...context(),
    globalArgs: { ...globalArgs, maxResponseBytes: 90 },
  };
  await assertRejects(
    () =>
      observeWatch(
        ctx,
        { paths: ["."], durationMs: 1_000, maxEvents: 10 },
        () => Promise.resolve(channel),
      ),
    Error,
    "maxResponseBytes",
  );
  assertEquals(channel.closed, true);
});

Deno.test("watch monotonic deadline stops an unbounded resolved queue", async () => {
  const channel = new FakeChannel([]);
  let reads = 0;
  channel.read = () => {
    reads++;
    return Promise.resolve(
      reads === 1
        ? text({ type: "subscribed" })
        : text({ type: "event", path: "queued", event: "write" }),
    );
  };
  const output = await observeWatch(
    context(undefined, { maxResponseBytes: 1_073_741_824 }),
    { paths: ["."], durationMs: 1, maxEvents: 100_000 },
    () => Promise.resolve(channel),
  );
  assertEquals(output.events.length < 100_000, true);
  assertEquals(reads < 100_001, true);
  assertEquals(channel.closed, true);
});

Deno.test("watch sends the exact subscription and preserves typed events up to its cap", async () => {
  const channel = new FakeChannel([
    text({ type: "subscribed", paths: ["src"] }),
    text({
      type: "event",
      path: "src/a.ts",
      event: "write",
      timestamp: "now",
      size: 4,
      isDir: false,
    }),
  ]);
  const output = await observeWatch(context(), {
    paths: ["src"],
    recursive: true,
    workingDir: "/app",
    durationMs: 1_000,
    maxEvents: 1,
  }, (_ctx, path) => {
    assertEquals(path, "/v1/sprites/demo%20sprite/fs/watch");
    return Promise.resolve(channel);
  });
  assertEquals(channel.sent, [
    JSON.stringify({
      type: "subscribe",
      paths: ["src"],
      recursive: true,
      workingDir: "/app",
    }),
  ]);
  assertEquals(output, {
    events: [{
      type: "event",
      path: "src/a.ts",
      event: "write",
      timestamp: "now",
      size: 4,
      isDir: false,
    }],
    truncated: true,
  });
  assertEquals(channel.closed, true);
});

Deno.test("watch requires acknowledgement and closes on protocol failure", async () => {
  const channel = new FakeChannel([
    text({ type: "event", path: "a", event: "create" }),
  ]);
  const error = await assertRejects(
    () =>
      observeWatch(
        context(),
        { paths: ["."], durationMs: 10 },
        () => Promise.resolve(channel),
      ),
    Error,
  );
  assertStringIncludes(error.message, "did not acknowledge");
  assertEquals(channel.closed, true);
});

Deno.test("watch cancellation fails and closes a pending read", async () => {
  const controller = new AbortController();
  const channel = new FakeChannel([]);
  const pending = observeWatch(context(controller.signal), {
    paths: ["."],
    durationMs: 1_000,
  }, () => Promise.resolve(channel));
  controller.abort(new Error("parent stopped"));
  await assertRejects(() => pending, Error, "parent stopped");
  assertEquals(channel.closed, true);
});

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
    assertEquals(
      error.message.includes("secret"),
      testCase.name === "transport error",
      testCase.name,
    );
    if (testCase.next instanceof Error) assertEquals(error, testCase.next);
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
