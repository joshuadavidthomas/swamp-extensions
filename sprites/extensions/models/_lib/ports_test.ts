// SPDX-License-Identifier: MIT
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { type Message } from "./socket.ts";
import {
  binaryFrame,
  FakeChannel,
  observationGlobalArgs as globalArgs,
  testContext,
  textFrame,
} from "./test_support.ts";
import { PortWatchArgs, watchPorts } from "./ports.ts";

const encoder = new TextEncoder();
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
    textFrame({ type: "port_list", ports: [opened] }),
    textFrame(closed),
  ]);
  const output = await watchPorts(
    testContext(globalArgs),
    PortWatchArgs.parse({ durationMs: 1_000, maxEvents: 1 }),
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
      textFrame({ type: "port_list", ports }),
      textFrame(opened),
    ]);
    const output = await watchPorts(
      testContext(globalArgs),
      PortWatchArgs.parse({ durationMs: 1_000, maxEvents: 1 }),
      () => Promise.resolve(channel),
    );
    assertEquals(output.initialPorts, []);
    assertEquals(output.notifications, [opened]);
    assertEquals(channel.closed, true);
  });
}

Deno.test("port watch requires a valid initial port_list snapshot", async () => {
  const cases: Array<{ name: string; message: Message }> = [
    { name: "notification", message: textFrame(opened) },
    {
      name: "missing ports",
      message: textFrame({ type: "port_list" }),
    },
    {
      name: "invalid port",
      message: textFrame({
        type: "port_list",
        ports: [{ ...opened, port: 0 }],
      }),
    },
    {
      name: "malformed JSON",
      message: { binary: false, bytes: encoder.encode("{secret") },
    },
    {
      name: "binary",
      message: binaryFrame(...encoder.encode("secret")),
    },
    {
      name: "error",
      message: textFrame({ type: "error", message: "secret" }),
    },
  ];
  for (const testCase of cases) {
    const channel = new FakeChannel([testCase.message]);
    const error = await assertRejects(
      () =>
        watchPorts(
          testContext(globalArgs),
          PortWatchArgs.parse({ durationMs: 100 }),
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
      ["observation", [textFrame({ type: "port_list", ports: [] }), null]],
    ] as const
  ) {
    const channel = new FakeChannel([...messages]);
    const error = await assertRejects(
      () =>
        watchPorts(
          testContext(globalArgs),
          PortWatchArgs.parse({ durationMs: 100 }),
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
      next: binaryFrame(...encoder.encode("secret")),
    },
    {
      name: "malformed JSON",
      next: { binary: false, bytes: encoder.encode("{secret") },
    },
    {
      name: "error frame",
      next: textFrame({ type: "error", message: "secret" }),
    },
    { name: "transport error", next: new Error("secret transport detail") },
  ];
  for (const testCase of cases) {
    const channel = new FakeChannel([
      textFrame({ type: "port_list", ports: [] }),
      testCase.next,
    ]);
    const error = await assertRejects(
      () =>
        watchPorts(
          testContext(globalArgs),
          PortWatchArgs.parse({ durationMs: 100 }),
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

Deno.test("port watch duration timer stops a continuing event stream", async () => {
  const channel = new FakeChannel([
    textFrame({ type: "port_list", ports: [] }),
  ]);
  let first = true;
  channel.read = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    channel.reads++;
    if (first) {
      first = false;
      return Promise.resolve(textFrame({ type: "port_list", ports: [] }));
    }
    return Promise.resolve(textFrame(opened));
  };
  const output = await watchPorts(
    testContext({ ...globalArgs, maxResponseBytes: 1_073_741_824 }),
    PortWatchArgs.parse({ durationMs: 1, maxEvents: 100_000 }),
    () => Promise.resolve(channel),
  );
  assert(output.notifications.length < 100_000);
  assert(channel.reads < 100_001);
  assertEquals(channel.closed, true);
});

Deno.test("port watch duration caps a pending observation after its snapshot", async () => {
  const channel = new FakeChannel([
    textFrame({ type: "port_list", ports: [opened] }),
  ]);
  const output = await watchPorts(
    testContext(globalArgs),
    PortWatchArgs.parse({ durationMs: 2 }),
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
  const first = textFrame({ type: "port_list", ports: [] });
  const next = textFrame(opened);
  const channel = new FakeChannel([first, next]);
  await assertRejects(
    () =>
      watchPorts(
        testContext({
          ...globalArgs,
          maxResponseBytes: first.bytes.length + next.bytes.length - 1,
        }),
        PortWatchArgs.parse({ durationMs: 1_000, maxEvents: 1 }),
        () => Promise.resolve(channel),
      ),
    Error,
    "maxResponseBytes",
  );
  assertEquals(channel.closed, true);
});

Deno.test("port watch maxEvents excludes the separately bounded initial snapshot", async () => {
  const channel = new FakeChannel([
    textFrame({ type: "port_list", ports: [opened, closed] }),
    textFrame(opened),
    textFrame(closed),
  ]);
  const output = await watchPorts(
    testContext(globalArgs),
    PortWatchArgs.parse({ durationMs: 1_000, maxEvents: 1 }),
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
    testContext(globalArgs, { signal: controller.signal }),
    PortWatchArgs.parse({ durationMs: 1_000 }),
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
        testContext({ ...globalArgs, timeoutMs: 2 }),
        PortWatchArgs.parse({ durationMs: 1_000 }),
        () => Promise.resolve(channel),
      ),
    Error,
    "timeoutMs",
  );
  assertEquals(channel.closed, true);
});
