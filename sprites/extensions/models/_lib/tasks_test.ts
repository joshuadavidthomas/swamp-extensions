// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { createMethods } from "./tasks.ts";
import { testContext } from "./test_support.ts";

const globalArgs = {
  token: "test-token",
  baseUrl: "https://api.sprites.dev",
  name: "demo",
  timeoutMs: 1000,
  maxResponseBytes: 10000,
};
const sprite = {
  id: "sprite-1",
  name: "demo",
  organization: "acme",
  url: "https://demo.sprites.app",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const task = {
  name: "task /;$(x)",
  started_at: "2026-09-10T00:00:00Z",
  expires_at: "2026-09-10T00:01:00Z",
};
const bytes = (text: string) => new TextEncoder().encode(text);
const result = (
  body = "",
  status = 204,
  exitCode = status >= 400 ? 22 : 0,
) => ({
  stdout: bytes(`${body}\n${status}`),
  stderr: new Uint8Array(),
  exitCode,
});
function setup(stored = true) {
  return testContext(globalArgs, {
    storedResources: stored ? { state: sprite } : {},
  });
}
const identity = () => new Response(JSON.stringify(sprite));

Deno.test("management reads reject invalid JSON and invalid shapes", async () => {
  for (
    const body of [
      "broken secret",
      '{"tasks":[{"name":"secret"}]}',
      '{"tasks":null}',
      "[]",
    ]
  ) {
    const test = setup();
    const methods = createMethods(() => Promise.resolve(result(body, 200)));
    const error = await assertRejects(
      () =>
        withMockedFetch(
          [identity()],
          () => methods.listTasks.execute({}, test),
        ),
      Error,
    );
    assertEquals(error.message.includes("secret"), false);
    assertEquals(test.getWrittenResources(), []);
  }
});

Deno.test("listTasks uses its local route and writes typed tasks", async () => {
  const test = setup();
  let count = 0;
  const methods = createMethods((_ctx, name, query, input) => {
    count++;
    const cmd = query.cmd as string[];
    assertEquals(name, globalArgs.name);
    assertEquals(cmd.slice(0, 2), ["/usr/bin/curl", "--disable"]);
    assertEquals(cmd[cmd.indexOf("--unix-socket") + 1], "/.sprite/api.sock");
    assertEquals(cmd[cmd.indexOf("--request") + 1], "GET");
    assertEquals(cmd.at(-1), "http://sprite/v1/tasks");
    assertEquals(cmd.includes(globalArgs.token), false);
    assertEquals(cmd.includes("--location"), false);
    assertEquals(cmd.includes("--retry"), false);
    assertEquals(cmd.includes("@-"), false);
    assertEquals(query.stdin, false);
    assertEquals(new TextDecoder().decode(input), "");
    return Promise.resolve(result(JSON.stringify({ tasks: [task] }), 200));
  });
  const { calls } = await withMockedFetch(
    [identity()],
    () => methods.listTasks.execute({}, test),
  );
  assertEquals(calls.length, 1);
  assertEquals(count, 1);
  assertEquals(test.getWrittenResources()[0].specName, "listTasks");
  assertEquals(test.getWrittenResources()[0].data, { tasks: [task] });
});
Deno.test("listTasks refuses missing or replaced Sprite identity before exec", async () => {
  for (const stored of [false, true]) {
    const test = setup(stored);
    let count = 0;
    const methods = createMethods(() => {
      count++;
      return Promise.resolve(result());
    });
    await withMockedFetch(
      stored
        ? [new Response(JSON.stringify({ ...sprite, id: "replacement" }))]
        : [],
      () =>
        assertRejects(
          () => methods.listTasks.execute({}, test),
          Error,
          stored ? "replaced" : "No Sprite identity is saved",
        ),
    );
    assertEquals(count, 0);
    assertEquals(test.getWrittenResources(), []);
  }
});
