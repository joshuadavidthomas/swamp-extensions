// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  childArgs,
  json,
  ndjson,
  noContent,
  sprite,
  testContext,
} from "./_lib/test_support.ts";
import { createMethods, model } from "./service.ts";
import { type Context } from "./_lib/core.ts";
import { type ManagementExec } from "./_lib/local-api.ts";
const globalArgs = { ...childArgs, service_name: "web/API" };
const parent = { name: sprite.name, id: sprite.id };
function runnable(name: keyof typeof model.methods) {
  return model.methods[name] as unknown as {
    execute(
      args: unknown,
      ctx: Context<typeof globalArgs>,
    ): Promise<{ dataHandles: unknown[] }>;
  };
}
type RouteCase = {
  name: keyof typeof model.methods;
  args: unknown;
  httpMethod: string;
  path: string;
  response: Response;
  verifies?: boolean;
  output?: string;
};

const service = {
  name: "web/API",
  cmd: "node",
  args: ["server.js"],
  env: { SECRET: "value" },
  dir: "/app",
  needs: [],
  http_port: 8080,
  state: {
    name: "web/API",
    status: "running",
    pid: 42,
    started_at: "2026-01-02T00:00:00Z",
    restart_count: 2,
    next_restart_at: "2026-01-03T00:00:00Z",
  },
};
const serviceStream = '{"type":"stdout","data":"ready\\n","timestamp":1}\n' +
  '{"type":"complete","timestamp":2,"log_files":{"stdout":"/.sprite/logs/web.log"}}\n';

const routeCases: RouteCase[] = [
  {
    name: "put",
    args: {
      duration: "5s",
      service: { cmd: "node", args: ["server.js"], needs: [] },
    },
    httpMethod: "PUT",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "state",
  },
  {
    name: "logs",
    args: { lines: 50, duration: "2s" },
    httpMethod: "GET",
    path:
      "/v1/sprites/demo%20sprite/services/web%2FAPI/logs?lines=50&duration=2s",
    response: ndjson(serviceStream),
    output: "logs",
  },
  {
    name: "start",
    args: { duration: "5s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/start?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "start",
  },
  {
    name: "stop",
    args: { timeout: "10s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/stop?timeout=10s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "stop",
  },
  {
    name: "restart",
    args: { duration: "5s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/restart?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "restart",
  },
  {
    name: "delete",
    args: {},
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI",
    response: noContent(),
    verifies: true,
  },
];

Deno.test("service methods use provider routes and validated output", async () => {
  for (const c of routeCases) {
    const test = testContext(globalArgs, {
      storedResources: { state: { ...service, sprite: parent } },
    });
    const { calls, result } = await withMockedFetch(
      [json(sprite), c.response, ...(c.name === "put" ? [json(service)] : [])],
      () => runnable(c.name).execute(c.args, test),
    );
    assertEquals(calls[0].method, "GET");
    assertEquals(
      calls[0].url,
      "https://api.sprites.dev/v1/sprites/demo%20sprite",
    );
    assertEquals(calls[1].method, c.httpMethod);
    assertEquals(calls[1].url, `https://api.sprites.dev${c.path}`);
    assertEquals(calls[1].headers.authorization, "Bearer test-token");
    assertEquals(test.getWrittenResources().at(-1)?.specName, c.output);
    if (c.name === "put") {
      assertEquals(result.dataHandles.length, 2);
      assertEquals(test.getWrittenResources()[0].specName, "put");
      assertEquals(test.getWrittenResources()[1].data, {
        ...service,
        sprite: parent,
      });
    }
    if (c.name === "delete") {
      assertEquals(test.getDeletedResources(), ["state"]);
    }
  }
});

Deno.test("startup exits fail even with complete, while stop and log exits remain data", async () => {
  for (
    const name of ["put", "start", "restart"] as const
  ) {
    for (const code of [0, 1, 137]) {
      for (const complete of ["", '{"type":"complete","timestamp":3}\n']) {
        const test = testContext(globalArgs, {
          storedResources: { state: { ...service, sprite: parent } },
        });
        const events =
          `{"type":"started","timestamp":1}\n{"type":"exit","exit_code":${code},"timestamp":2}\n${complete}`;
        await assertRejects(
          () =>
            withMockedFetch(
              [json(sprite), ndjson(events)],
              () =>
                runnable(name).execute(
                  model.methods[name].arguments.parse({ service }),
                  test,
                ),
            ),
          Error,
          `exited during startup with code ${code}`,
        );
      }
    }
  }
  for (
    const name of ["stop", "logs", "restart"] as const
  ) {
    const test = testContext(globalArgs, {
      storedResources: { state: { ...service, sprite: parent } },
    });
    const event = name === "logs" ? "exit" : "stopped";
    const events = `{"type":"${event}","exit_code":143,"timestamp":1}\n` +
      (name === "restart" ? '{"type":"started","timestamp":2}\n' : "") +
      '{"type":"complete","timestamp":3}\n';
    await withMockedFetch(
      [json(sprite), ndjson(events)],
      () => runnable(name).execute({}, test),
    );
    assertEquals(test.getWrittenResources().length, 1);
  }
});

Deno.test("service refuses an unbound or replaced Sprite before a non-binding method", async () => {
  for (const bound of [false, true]) {
    const test = testContext(globalArgs, {
      storedResources: bound ? { state: { ...service, sprite: parent } } : {},
    });
    const { calls } = await withMockedFetch(
      bound ? [json({ ...sprite, id: "replacement" })] : [],
      () =>
        assertRejects(
          () => model.methods.start.execute({}, test),
          Error,
          bound ? "replaced" : "No Sprite identity is saved",
        ),
    );
    assertEquals(calls.length, bound ? 1 : 0);
    assertEquals(test.getWrittenResources(), []);
  }
});
Deno.test("service put and get bind the Sprite identity on an unbound instance", async () => {
  for (const name of ["put", "get"] as const) {
    const test = testContext(globalArgs);
    await withMockedFetch(
      [
        json(sprite),
        ...(name === "put" ? [ndjson(serviceStream)] : []),
        json(service),
      ],
      () => runnable(name).execute(name === "put" ? { service } : {}, test),
    );
    assertEquals(test.getWrittenResources().at(-1)?.data, {
      ...service,
      sprite: parent,
    });
  }
});
Deno.test("service logs refuse incomplete streams", async () => {
  const test = testContext(globalArgs, {
    storedResources: { state: { ...service, sprite: parent } },
  });
  await withMockedFetch(
    [
      json(sprite),
      ndjson('{"type":"stdout","data":"still running","timestamp":1}\n'),
    ],
    () =>
      assertRejects(
        () => model.methods.logs.execute({}, test),
        Error,
        "without a complete event",
      ),
  );
  assertEquals(test.getWrittenResources(), []);
});
Deno.test("service signal uses fixed local route and stdin JSON", async () => {
  const test = testContext(globalArgs, {
    storedResources: { state: { ...service, sprite: parent } },
  });
  let called = 0;
  const execute: ManagementExec = (_ctx, name, query, input) => {
    called++;
    assertEquals(name, childArgs.sprite);
    const cmd = query.cmd as string[];
    assertEquals(cmd.slice(0, 2), ["/usr/bin/curl", "--disable"]);
    assertEquals(cmd[cmd.indexOf("--unix-socket") + 1], "/.sprite/api.sock");
    assertEquals(cmd[cmd.indexOf("--request") + 1], "POST");
    assertEquals(cmd.at(-1), "http://sprite/v1/services/signal");
    assertEquals(cmd.includes(globalArgs.token), false);
    assertEquals(cmd.includes("--location"), false);
    assertEquals(cmd.includes("--retry"), false);
    assertEquals(
      new TextDecoder().decode(input),
      JSON.stringify({ name: service.name, signal: "USR1" }),
    );
    assertEquals(cmd.includes("@-"), true);
    assertEquals(query.stdin, true);
    return Promise.resolve({
      stdout: new TextEncoder().encode("\n204"),
      stderr: new Uint8Array(),
      exitCode: 0,
    });
  };
  const { calls } = await withMockedFetch(
    [json(sprite)],
    () => createMethods(execute).signal.execute({ signal: "USR1" }, test),
  );
  assertEquals(calls.length, 1);
  assertEquals(called, 1);
  assertEquals(test.getWrittenResources(), []);
});
Deno.test("service signal refuses missing or replaced identity before exec", async () => {
  for (const bound of [false, true]) {
    let called = 0;
    const methods = createMethods(() => {
      called++;
      throw new Error("must not execute");
    });
    const test = testContext(globalArgs, {
      storedResources: bound ? { state: { ...service, sprite: parent } } : {},
    });
    await withMockedFetch(
      bound ? [json({ ...sprite, id: "replacement" })] : [],
      () =>
        assertRejects(
          () => methods.signal.execute({ signal: "USR1" }, test),
          Error,
          bound ? "replaced" : "No Sprite identity is saved",
        ),
    );
    assertEquals(called, 0);
    assertEquals(test.getWrittenResources(), []);
  }
});
Deno.test("service REST get rejects invalid shapes and HTTP errors without saving", async () => {
  for (
    const response of [
      json({ ...service, needs: undefined }),
      json({ error: "missing" }, 404),
      new Response("{broken"),
    ]
  ) {
    const test = testContext(globalArgs);
    const { calls } = await withMockedFetch(
      [json(sprite), response],
      () => assertRejects(() => model.methods.get.execute({}, test), Error),
    );
    assertEquals(calls.length, 2);
    assertEquals(test.getWrittenResources(), []);
  }
});

Deno.test("service delete accepts absence and preserves identity on other failures", async () => {
  for (const status of [404, 500]) {
    const test = testContext(globalArgs, {
      storedResources: { state: { ...service, sprite: parent } },
    });
    const { calls } = await withMockedFetch([
      json(sprite),
      json({ error: "missing" }, status),
    ], async () => {
      if (status === 404) await model.methods.delete.execute({}, test);
      else {await assertRejects(() =>
          model.methods.delete.execute({}, test), Error);}
    });
    assertEquals(calls.map((c) => c.method), ["GET", "DELETE"]);
    assertEquals(test.getDeletedResources(), status === 404 ? ["state"] : []);
  }
});

Deno.test("service REST get preserves the nullable definition and process state from the socket fixture", async () => {
  const observed = {
    name: "web/API",
    cmd: "node",
    args: null,
    needs: null,
    state: { name: "web/API", status: "running", pid: 42 },
  };
  const test = testContext(globalArgs);
  await withMockedFetch(
    [json(sprite), json(observed)],
    () => model.methods.get.execute({}, test),
  );
  assertEquals(test.getWrittenResources()[0].data, {
    ...observed,
    sprite: parent,
  });
});
