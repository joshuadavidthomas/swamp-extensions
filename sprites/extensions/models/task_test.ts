// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { type ManagementExec } from "./_lib/local-api.ts";
import { createMethods } from "./task.ts";
import { TaskExpiry } from "./_lib/tasks.ts";
import { testContext } from "./_lib/test_support.ts";

const globalArgs = {
  token: "test-token",
  baseUrl: "https://api.sprites.dev",
  sprite: "demo",
  name: "task /;$(x)",
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
    storedResources: stored
      ? { task: { ...task, sprite: { name: sprite.name, id: sprite.id } } }
      : {},
  });
}
const identity = () => new Response(JSON.stringify(sprite));

Deno.test("management methods use fixed local routes, stdin JSON and typed outputs", async () => {
  const cases = [
    {
      method: "get",
      input: {},
      verb: "GET",
      path: `/v1/tasks/${encodeURIComponent(task.name)}`,
      status: 200,
      response: JSON.stringify(task),
      spec: "task",
      output: task,
    },
    {
      method: "create",
      input: { expire: 60 },
      verb: "POST",
      path: "/v1/tasks",
      body: { name: task.name, expire: 60 },
      status: 201,
      response: "unpublished success body",
      spec: "task",
      output: task,
    },
    {
      method: "refresh",
      input: { expire: "30s" },
      verb: "PUT",
      path: `/v1/tasks/${encodeURIComponent(task.name)}`,
      body: { expire: "30s" },
      status: 200,
      response: "",
      spec: "task",
      output: task,
    },
    {
      method: "delete",
      input: {},
      verb: "DELETE",
      path: `/v1/tasks/${encodeURIComponent(task.name)}`,
      status: 204,
      response: "",
      output: undefined,
    },
    {
      method: "delete",
      input: {},
      verb: "DELETE",
      path: `/v1/tasks/${encodeURIComponent(task.name)}`,
      status: 404,
      response: "not found",
      output: undefined,
    },
  ] as const;
  for (const c of cases) {
    const test = setup();
    let called = 0;
    const execute: ManagementExec = (_ctx, name, query, input) => {
      assertEquals(name, globalArgs.sprite);
      called++;
      const cmd = query.cmd as string[];
      if (called === 2) {
        assertEquals(cmd[cmd.indexOf("--request") + 1], "GET");
        assertEquals(
          cmd.at(-1),
          `http://sprite/v1/tasks/${encodeURIComponent(task.name)}`,
        );
        assertEquals(query.stdin, false);
        assertEquals(new TextDecoder().decode(input), "");
        return Promise.resolve(result(JSON.stringify(task), 200));
      }
      assertEquals(cmd.slice(0, 2), ["/usr/bin/curl", "--disable"]);
      assertEquals(cmd[cmd.indexOf("--unix-socket") + 1], "/.sprite/api.sock");
      assertEquals(cmd[cmd.indexOf("--request") + 1], c.verb);
      assertEquals(cmd.at(-1), `http://sprite${c.path}`);
      assertEquals(cmd.includes(globalArgs.token), false);
      assertEquals(cmd.includes("--location"), false);
      assertEquals(cmd.includes("--retry"), false);
      assertEquals(
        new TextDecoder().decode(input),
        "body" in c ? JSON.stringify(c.body) : "",
      );
      assertEquals(cmd.includes("@-"), "body" in c);
      assertEquals(query.stdin, "body" in c);
      return Promise.resolve(result(c.response, c.status));
    };
    const methods = createMethods(execute);
    const { calls } = await withMockedFetch(
      [identity()],
      () => methods[c.method].execute(c.input as never, test),
    );
    assertEquals(calls.length, 1);
    assertEquals(
      called,
      c.method === "create" || c.method === "refresh" ? 2 : 1,
    );
    if (c.method === "delete") {
      assertEquals(test.getDeletedResources(), ["task"]);
    }
    if (c.output !== undefined) {
      const written = test.getWrittenResources()[0];
      assertEquals(written.specName, c.spec);
      assertEquals(written.data, {
        ...c.output,
        sprite: { name: sprite.name, id: sprite.id },
      });
    }
  }
});

Deno.test("management failures are sanitized and never replay a mutation", async () => {
  for (
    const response of [
      result("secret-body", 409),
      result("secret-body", 500),
      result("secret-body", 302),
      result("secret-body", 201, 28),
      {
        stdout: bytes("secret-body"),
        stderr: bytes("secret-stderr"),
        exitCode: 0,
      },
      {
        stdout: new Uint8Array([255, 10, 50, 48, 49]),
        stderr: new Uint8Array(),
        exitCode: 0,
      },
    ]
  ) {
    const test = setup();
    let count = 0;
    const methods = createMethods(() => {
      count++;
      return Promise.resolve(response);
    });
    const error = await assertRejects(
      () =>
        withMockedFetch(
          [identity()],
          () => methods.create.execute({ expire: 60 }, test),
        ),
      Error,
    );
    assertEquals(error.message.includes("secret"), false);
    assertEquals(count, 1);
    assertEquals(test.getWrittenResources(), []);
  }
});

Deno.test("task expiry is positive, bounded and preserves provider input type", () => {
  for (const value of [1, 3600, "30s", "1h", "30m30s", "0.5s", "1ms"]) {
    assertEquals(TaskExpiry.parse(value), value);
  }
  for (
    const value of [
      0,
      -1,
      3601,
      1.5,
      "0s",
      "2h",
      "1h1s",
      "NaN",
      "1s;echo secret",
      "",
      Infinity,
    ]
  ) assertEquals(TaskExpiry.safeParse(value).success, false);
});

Deno.test("management cancellation and elapsed deadlines cannot produce success", async () => {
  for (const cancel of [false, true]) {
    const test = setup();
    const controller = new AbortController();
    test.signal = controller.signal;
    test.globalArgs = { ...globalArgs, timeoutMs: 30 };
    const methods = createMethods(() => {
      if (cancel) controller.abort();
      else {
        const deadline = performance.now() + 40;
        while (
          performance.now() < deadline
        ) { /* Queue starvation: timer cannot fire. */ }
      }
      return Promise.resolve(result("", 201));
    });
    await assertRejects(
      () =>
        withMockedFetch(
          [identity()],
          () => methods.create.execute({ expire: 1 }, test),
        ),
      Error,
    );
    assertEquals(test.getWrittenResources(), []);
  }
});

Deno.test("task refuses unbound or replaced Sprite before local exec", async () => {
  for (const stored of [false, true]) {
    const test = setup(stored);
    let count = 0;
    const methods = createMethods(() => {
      count++;
      return Promise.resolve(result());
    });
    const { calls } = await withMockedFetch(
      stored
        ? [new Response(JSON.stringify({ ...sprite, id: "replacement" }))]
        : [],
      () =>
        assertRejects(
          () => methods.refresh.execute({ expire: 60 }, test),
          Error,
          stored ? "replaced" : "No Sprite identity is saved",
        ),
    );
    assertEquals(count, 0);
    assertEquals(calls.length, stored ? 1 : 0);
    assertEquals(test.getWrittenResources(), []);
  }
});
Deno.test("task create and get bind and save their Sprite identity", async () => {
  for (const method of ["create", "get"] as const) {
    const test = setup(false);
    const methods = createMethods((_ctx, name, query) => {
      assertEquals(name, globalArgs.sprite);
      return Promise.resolve(
        (query.cmd as string[]).includes("POST")
          ? result("", 201)
          : result(JSON.stringify(task), 200),
      );
    });
    await withMockedFetch(
      [identity()],
      () =>
        methods[method].execute(
          methods[method].arguments.parse({ expire: 60 }) as never,
          test,
        ),
    );
    assertEquals(test.getWrittenResources()[0].data, {
      ...task,
      sprite: { name: sprite.name, id: sprite.id },
    });
  }
});
Deno.test("task get rejects invalid shapes, HTTP errors, and malformed JSON", async () => {
  for (
    const response of [
      result(JSON.stringify({ name: task.name }), 200),
      result("missing", 404),
      result("{broken", 200),
    ]
  ) {
    const test = setup();
    let count = 0;
    const methods = createMethods((_ctx, _name, query) => {
      count++;
      assertEquals(query.stdin, false);
      return Promise.resolve(response);
    });
    await withMockedFetch(
      [identity()],
      () => assertRejects(() => methods.get.execute({}, test), Error),
    );
    assertEquals(count, 1);
    assertEquals(test.getWrittenResources(), []);
  }
});
