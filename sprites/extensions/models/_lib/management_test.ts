// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  createManagementMethods,
  type ManagementExec,
  TaskExpiry,
} from "./management.ts";
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
const service = {
  name: "web/API",
  cmd: "node",
  args: null,
  needs: null,
  state: {
    name: "web/API",
    status: "running",
    pid: 42,
  },
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
  const test = testContext(globalArgs, {
    storedResources: stored ? { state: sprite } : {},
  });
  return {
    ...test,
    ctx: test,
  };
}
const identity = () => new Response(JSON.stringify(sprite));

Deno.test("management methods use fixed local routes, stdin JSON and typed outputs", async () => {
  const cases = [
    {
      method: "getService",
      input: { service_name: service.name },
      verb: "GET",
      path: `/v1/services/${encodeURIComponent(service.name)}`,
      status: 200,
      response: JSON.stringify(service),
      spec: "service",
      output: service,
    },
    {
      method: "signalService",
      input: { service_name: task.name, signal: "USR1" },
      verb: "POST",
      path: "/v1/services/signal",
      body: { name: task.name, signal: "USR1" },
      status: 204,
      response: "",
      output: undefined,
    },
    {
      method: "listTasks",
      input: {},
      verb: "GET",
      path: "/v1/tasks",
      status: 200,
      response: JSON.stringify({ tasks: [task] }),
      spec: "tasks",
      output: { tasks: [task] },
    },
    {
      method: "getTask",
      input: { name: task.name },
      verb: "GET",
      path: `/v1/tasks/${encodeURIComponent(task.name)}`,
      status: 200,
      response: JSON.stringify(task),
      spec: "task",
      output: task,
    },
    {
      method: "createTask",
      input: { name: task.name, expire: 60 },
      verb: "POST",
      path: "/v1/tasks",
      body: { name: task.name, expire: 60 },
      status: 201,
      response: "unpublished success body",
      spec: "taskCreated",
      output: { name: task.name, expire: 60 },
    },
    {
      method: "refreshTask",
      input: { name: task.name, expire: "30s" },
      verb: "PUT",
      path: `/v1/tasks/${encodeURIComponent(task.name)}`,
      body: { expire: "30s" },
      status: 200,
      response: "",
      spec: "taskRefreshed",
      output: { name: task.name, expire: "30s" },
    },
    {
      method: "deleteTask",
      input: { name: task.name },
      verb: "DELETE",
      path: `/v1/tasks/${encodeURIComponent(task.name)}`,
      status: 204,
      response: "",
      output: undefined,
    },
    {
      method: "deleteTask",
      input: { name: task.name },
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
    const execute: ManagementExec = (_ctx, query, input) => {
      called++;
      const cmd = query.cmd as string[];
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
    const methods = createManagementMethods(execute);
    const { calls } = await withMockedFetch(
      [identity()],
      () => methods[c.method].execute(c.input as never, test.ctx),
    );
    assertEquals(calls.length, 1);
    assertEquals(called, 1);
    if (c.output !== undefined) {
      const written = test.getWrittenResources()[0];
      assertEquals(written.specName, c.spec);
      assertEquals(written.data, c.output);
    }
  }
});

Deno.test("getService rejects invalid shapes, HTTP errors, and malformed JSON", async () => {
  const failures = [
    result(JSON.stringify({ ...service, needs: undefined }), 200),
    result("not found", 404),
    result("{broken", 200),
  ];
  for (const response of failures) {
    const test = setup();
    let count = 0;
    const methods = createManagementMethods((_ctx, query) => {
      count++;
      assertEquals(query.stdin, false);
      return Promise.resolve(response);
    });
    await assertRejects(
      () =>
        withMockedFetch(
          [identity()],
          () =>
            methods.getService.execute(
              { service_name: service.name },
              test.ctx,
            ),
        ),
      Error,
    );
    assertEquals(count, 1);
    assertEquals(test.getWrittenResources(), []);
  }
});

Deno.test("getService requires the saved Sprite identity before local exec", async () => {
  const test = setup(false);
  let count = 0;
  const methods = createManagementMethods(() => {
    count++;
    return Promise.resolve(result(JSON.stringify(service), 200));
  });
  await assertRejects(
    () =>
      withMockedFetch(
        [],
        () =>
          methods.getService.execute({ service_name: service.name }, test.ctx),
      ),
    Error,
  );
  assertEquals(count, 0);
  assertEquals(test.getWrittenResources(), []);
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
    const methods = createManagementMethods(() => {
      count++;
      return Promise.resolve(response);
    });
    const error = await assertRejects(
      () =>
        withMockedFetch(
          [identity()],
          () =>
            methods.createTask.execute({ name: "agent", expire: 60 }, test.ctx),
        ),
      Error,
    );
    assertEquals(error.message.includes("secret"), false);
    assertEquals(count, 1);
    assertEquals(test.getWrittenResources(), []);
  }
});

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
    const methods = createManagementMethods(() =>
      Promise.resolve(result(body, 200))
    );
    const error = await assertRejects(
      () =>
        withMockedFetch(
          [identity()],
          () => methods.listTasks.execute({}, test.ctx),
        ),
      Error,
    );
    assertEquals(error.message.includes("secret"), false);
    assertEquals(test.getWrittenResources(), []);
  }
});

Deno.test("management refuses missing or replaced Sprite identity before exec", async () => {
  for (const stored of [false, true]) {
    const test = setup(stored);
    let count = 0;
    const methods = createManagementMethods(() => {
      count++;
      return Promise.resolve(result());
    });
    await assertRejects(
      () =>
        withMockedFetch(
          stored
            ? [new Response(JSON.stringify({ ...sprite, id: "replacement" }))]
            : [],
          () =>
            methods.signalService.execute({
              service_name: "web",
              signal: "USR1",
            }, test.ctx),
        ),
      Error,
    );
    assertEquals(count, 0);
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
    test.ctx.signal = controller.signal;
    test.ctx.globalArgs = { ...globalArgs, timeoutMs: 30 };
    const methods = createManagementMethods(() => {
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
          () =>
            methods.createTask.execute({ name: "agent", expire: 1 }, test.ctx),
        ),
      Error,
    );
    assertEquals(test.getWrittenResources(), []);
  }
});
