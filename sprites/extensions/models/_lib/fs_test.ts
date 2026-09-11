// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  FakeChannel,
  globalArgs,
  json,
  observationGlobalArgs,
  registerRouteCases,
  type RouteCase,
  runnable,
  sprite,
  testContext,
  textFrame,
} from "./test_support.ts";
import { observeWatch, WatchArgs } from "./fs.ts";

const routeCases: RouteCase[] = [
  {
    name: "listFiles",
    args: { path: "/app", workingDir: "/" },
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/fs/list?path=%2Fapp&workingDir=%2F",
    response: json({
      path: "/app",
      entries: [{
        name: "index.ts",
        path: "/app/index.ts",
        type: "file",
        size: 12,
        mode: "0644",
        modTime: "2026-01-02T00:00:00Z",
        isDir: false,
      }],
      count: 1,
    }),
    output: "listFiles",
  },
  {
    name: "writeFile",
    args: {
      path: "a.bin",
      workingDir: "/app",
      mode: "0640",
      mkdir: true,
      content: { kind: "text", text: "hello" },
    },
    httpMethod: "PUT",
    path:
      "/v1/sprites/demo%20sprite/fs/write?path=a.bin&workingDir=%2Fapp&mode=0640&mkdir=true",
    response: json({ path: "/app/a.bin", size: 5, mode: "0640" }),
    verifies: true,
    output: "writeFile",
  },
  {
    name: "deleteFile",
    args: { path: "old", workingDir: "/app", recursive: true, asRoot: false },
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/fs/delete",
    response: json({ deleted: ["/app/old"], count: 1 }),
    verifies: true,
    output: "deleteFile",
  },
  {
    name: "copyFile",
    args: {
      source: "a",
      dest: "b",
      workingDir: "/app",
      recursive: true,
      preserveAttrs: true,
      asRoot: false,
    },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/fs/copy",
    response: json({
      copied: [{ source: "/app/a", dest: "/app/b" }],
      count: 1,
      totalBytes: 5,
    }),
    verifies: true,
    output: "copyFile",
  },
  {
    name: "renameFile",
    args: { source: "a", dest: "b", workingDir: "/app", asRoot: true },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/fs/rename",
    response: json({ source: "/app/a", dest: "/app/b" }),
    verifies: true,
    output: "renameFile",
  },
  {
    name: "chmodFile",
    args: {
      path: "a",
      workingDir: "/app",
      mode: "0755",
      recursive: false,
      asRoot: true,
    },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/fs/chmod",
    response: json({ affected: [{ path: "/app/a", mode: "0755" }], count: 1 }),
    verifies: true,
    output: "chmodFile",
  },
  {
    name: "chownFile",
    args: {
      path: "a",
      workingDir: "/app",
      uid: 1000,
      gid: 1000,
      recursive: true,
      asRoot: true,
    },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/fs/chown",
    response: json({
      affected: [{ path: "/app/a", uid: 1000, gid: 1000 }],
      count: 1,
    }),
    verifies: true,
    output: "chownFile",
  },
];

registerRouteCases(routeCases);

Deno.test("filesystem requests preserve binary bytes and DELETE uses a JSON body", async () => {
  const readContext = testContext(globalArgs);
  const readResult = await withMockedFetch(
    [new Response(new Uint8Array([0, 255, 1, 128]))],
    () =>
      runnable("readFile").execute(
        { path: "raw.bin", workingDir: "/data" },
        readContext,
      ),
  );
  assertEquals(
    readResult.calls[0].url,
    "https://api.sprites.dev/v1/sprites/demo%20sprite/fs/read?path=raw.bin&workingDir=%2Fdata",
  );
  assertEquals(readContext.getWrittenFiles().length, 1);

  const deleteContext = testContext(globalArgs, {
    storedResources: { state: sprite },
  });
  const deleted = await withMockedFetch(
    [json(sprite), json({ deleted: ["/data/raw.bin"], count: 1 })],
    () =>
      runnable("deleteFile").execute({
        path: "raw.bin",
        workingDir: "/data",
        recursive: false,
        asRoot: true,
      }, deleteContext),
  );
  assertEquals(JSON.parse(deleted.calls[1].body ?? "null"), {
    path: "raw.bin",
    workingDir: "/data",
    recursive: false,
    asRoot: true,
  });
});

{
  const globalArgs = observationGlobalArgs;
  Deno.test("watch reports bounded provider errors with the bearer token removed", async () => {
    const channel = new FakeChannel([
      textFrame({
        type: "error",
        message: `failed for ${globalArgs.token}\n\u2028\u202e${
          "x".repeat(1000)
        }`,
      }),
    ]);
    const error = await assertRejects(
      () =>
        observeWatch(
          testContext(globalArgs),
          WatchArgs.parse({ paths: ["."], durationMs: 100 }),
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
      textFrame({ type: "subscribed" }),
      textFrame({ type: "event", path: "first-long-path", event: "write" }),
      textFrame({ type: "event", path: "second-long-path", event: "write" }),
    ]);
    const ctx = {
      ...testContext(globalArgs),
      globalArgs: { ...globalArgs, maxResponseBytes: 90 },
    };
    await assertRejects(
      () =>
        observeWatch(
          ctx,
          WatchArgs.parse({ paths: ["."], durationMs: 1_000, maxEvents: 10 }),
          () => Promise.resolve(channel),
        ),
      Error,
      "maxResponseBytes",
    );
    assertEquals(channel.closed, true);
  });

  Deno.test("watch duration timer stops a continuing event stream", async () => {
    const channel = new FakeChannel([]);
    let reads = 0;
    channel.read = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      reads++;
      return Promise.resolve(
        reads === 1
          ? textFrame({ type: "subscribed" })
          : textFrame({ type: "event", path: "queued", event: "write" }),
      );
    };
    const output = await observeWatch(
      testContext({ ...globalArgs, maxResponseBytes: 1_073_741_824 }),
      WatchArgs.parse({ paths: ["."], durationMs: 1, maxEvents: 100_000 }),
      () => Promise.resolve(channel),
    );
    assertEquals(output.events.length < 100_000, true);
    assertEquals(reads < 100_001, true);
    assertEquals(channel.closed, true);
  });

  Deno.test("watch sends the exact subscription and preserves typed events up to its cap", async () => {
    const channel = new FakeChannel([
      textFrame({ type: "subscribed", paths: ["src"] }),
      textFrame({
        type: "event",
        path: "src/a.ts",
        event: "write",
        timestamp: "now",
        size: 4,
        isDir: false,
      }),
    ]);
    const output = await observeWatch(
      testContext(globalArgs),
      WatchArgs.parse({
        paths: ["src"],
        recursive: true,
        workingDir: "/app",
        durationMs: 1_000,
        maxEvents: 1,
      }),
      (_ctx, path) => {
        assertEquals(path, "/v1/sprites/demo%20sprite/fs/watch");
        return Promise.resolve(channel);
      },
    );
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
      textFrame({ type: "event", path: "a", event: "create" }),
    ]);
    const error = await assertRejects(
      () =>
        observeWatch(
          testContext(globalArgs),
          WatchArgs.parse({ paths: ["."], durationMs: 10 }),
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
    const pending = observeWatch(
      testContext(globalArgs, { signal: controller.signal }),
      WatchArgs.parse({
        paths: ["."],
        durationMs: 1_000,
      }),
      () => Promise.resolve(channel),
    );
    controller.abort(new Error("parent stopped"));
    await assertRejects(() => pending, Error, "parent stopped");
    assertEquals(channel.closed, true);
  });
}
