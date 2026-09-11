// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { restMethods } from "./sprite-rest.ts";

import type { SpriteContext } from "./sprite-api.ts";
import { testContext } from "./test_support.ts";

const globalArgs = {
  token: "test-token",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
};
const sprite = {
  id: "sprite-1",
  name: "demo sprite",
  organization: "acme",
  url: "https://demo.sprites.app",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const checkpoint = {
  id: "v1",
  create_time: "2026-01-02T00:00:00Z",
  comment: "safe",
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
const fsList = {
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
};
const checkpointStream =
  '{"type":"info","data":"working","time":"2026-01-02T00:00:00Z"}\n' +
  '{"type":"complete","data":"done","time":"2026-01-02T00:00:01Z"}\n';
const serviceStream = '{"type":"stdout","data":"ready\\n","timestamp":1}\n' +
  '{"type":"complete","timestamp":2,"log_files":{"stdout":"/.sprite/logs/web.log"}}\n';

type Runnable = {
  execute(
    input: unknown,
    ctx: SpriteContext,
  ): Promise<{ dataHandles: Array<{ name: string }> }>;
};
function runnable(name: keyof typeof restMethods): Runnable {
  return restMethods[name] as unknown as Runnable;
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
  });
}
function ndjson(value: string): Response {
  return new Response(value, {});
}
function noContent(): Response {
  return new Response(null, { status: 204 });
}

const routeCases: Array<{
  name: keyof typeof restMethods;
  args: unknown;
  httpMethod: string;
  path: string;
  response: Response;
  verifies?: boolean;
  output?: string;
}> = [
  {
    name: "create",
    args: {},
    httpMethod: "POST",
    path: "/v1/sprites",
    response: json(sprite, 201),
    output: "state",
  },
  {
    name: "lookup",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite",
    response: json(sprite),
    output: "state",
  },
  {
    name: "update",
    args: { labels: ["prod"] },
    httpMethod: "PUT",
    path: "/v1/sprites/demo%20sprite",
    response: json({ ...sprite, labels: ["prod"] }),
    verifies: true,
    output: "state",
  },
  {
    name: "upgrade",
    args: {},
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/upgrade",
    response: noContent(),
    verifies: true,
  },
  {
    name: "delete",
    args: {},
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite",
    response: noContent(),
    verifies: true,
  },
  {
    name: "createCheckpoint",
    args: { comment: "safe" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/checkpoint",
    response: ndjson(checkpointStream),
    verifies: true,
    output: "checkpointCreated",
  },
  {
    name: "listCheckpoints",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/checkpoints",
    response: json([checkpoint]),
    output: "checkpoints",
  },
  {
    name: "getCheckpoint",
    args: { checkpoint_id: "v/1" },
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/checkpoints/v%2F1",
    response: json(checkpoint),
    output: "checkpoint",
  },
  {
    name: "restoreCheckpoint",
    args: { checkpoint_id: "v/1" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/checkpoints/v%2F1/restore",
    response: ndjson(checkpointStream),
    verifies: true,
    output: "checkpointRestored",
  },
  {
    name: "getNetworkPolicy",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/policy/network",
    response: json({ rules: [{ action: "allow", domain: "example.com" }] }),
    output: "networkPolicy",
  },
  {
    name: "setNetworkPolicy",
    args: { rules: [{ include: "defaults" }] },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/policy/network",
    response: noContent(),
    verifies: true,
  },
  {
    name: "getPrivilegesPolicy",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/policy/privileges",
    response: json({
      profile: "standard",
      devices: ["null"],
      noNewPrivileges: true,
    }),
    output: "privilegesPolicy",
  },
  {
    name: "setPrivilegesPolicy",
    args: { noNewPrivileges: true },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/policy/privileges",
    response: noContent(),
    verifies: true,
  },
  {
    name: "deletePrivilegesPolicy",
    args: {},
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/policy/privileges",
    response: noContent(),
    verifies: true,
  },
  {
    name: "getResourcesPolicy",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/policy/resources",
    response: json({ memory: { limit_mb: 512, autoscale: true } }),
    output: "resourcesPolicy",
  },
  {
    name: "setResourcesPolicy",
    args: { memory: { limit_mb: 1024 } },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/policy/resources",
    response: noContent(),
    verifies: true,
  },
  {
    name: "deleteResourcesPolicy",
    args: {},
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/policy/resources",
    response: noContent(),
    verifies: true,
  },
  {
    name: "listServices",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/services",
    response: json([service]),
    output: "services",
  },
  {
    name: "putService",
    args: {
      service_name: "web/API",
      duration: "5s",
      service: { cmd: "node", args: ["server.js"], needs: [] },
    },
    httpMethod: "PUT",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "servicePut",
  },
  {
    name: "getServiceLogs",
    args: { service_name: "web/API", lines: 50, duration: "2s" },
    httpMethod: "GET",
    path:
      "/v1/sprites/demo%20sprite/services/web%2FAPI/logs?lines=50&duration=2s",
    response: ndjson(serviceStream),
    output: "serviceLogs",
  },
  {
    name: "startService",
    args: { service_name: "web/API", duration: "5s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/start?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "serviceStarted",
  },
  {
    name: "stopService",
    args: { service_name: "web/API", timeout: "10s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/stop?timeout=10s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "serviceStopped",
  },
  {
    name: "restartService",
    args: { service_name: "web/API", duration: "5s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/restart?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "serviceRestarted",
  },
  {
    name: "deleteService",
    args: { service_name: "web/API" },
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI",
    response: noContent(),
    verifies: true,
  },
  {
    name: "listFiles",
    args: { path: "/app", workingDir: "/" },
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/fs/list?path=%2Fapp&workingDir=%2F",
    response: json(fsList),
    output: "files",
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
    output: "fileWritten",
  },
  {
    name: "deleteFile",
    args: { path: "old", workingDir: "/app", recursive: true, asRoot: false },
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/fs/delete",
    response: json({ deleted: ["/app/old"], count: 1 }),
    verifies: true,
    output: "fileDeleted",
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
    output: "fileCopied",
  },
  {
    name: "renameFile",
    args: { source: "a", dest: "b", workingDir: "/app", asRoot: true },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/fs/rename",
    response: json({ source: "/app/a", dest: "/app/b" }),
    verifies: true,
    output: "fileRenamed",
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
    output: "fileModeChanged",
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
    output: "fileOwnerChanged",
  },
];

Deno.test("every JSON and NDJSON REST method uses its provider route and writes validated output", async () => {
  for (const testCase of routeCases) {
    const context = testContext(globalArgs, {
      storedResources: { state: sprite },
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
      assertEquals(calls[0].method, "GET", `${testCase.name} preflight method`);
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

Deno.test("upgrade sends a bodyless request", async () => {
  const test = testContext(globalArgs, {
    storedResources: { state: sprite },
  });
  const { calls } = await withMockedFetch(
    [json(sprite), noContent()],
    () => runnable("upgrade").execute({}, test),
  );
  assertEquals(calls[1].body, "");
});

Deno.test("upgrade sends the explicitly requested version", async () => {
  const test = testContext(globalArgs, {
    storedResources: { state: sprite },
  });
  let body: unknown;
  await withMockedFetch(
    async (request) => {
      if (request.method === "GET") return json(sprite);
      body = await request.json();
      return noContent();
    },
    () => runnable("upgrade").execute({ version: "0.0.1-rc48" }, test),
  );
  assertEquals(body, { version: "0.0.1-rc48" });
});

Deno.test("upgrade API errors write no acknowledgement", async () => {
  const test = testContext(globalArgs, {
    storedResources: { state: sprite },
  });
  await assertRejects(
    () =>
      withMockedFetch(
        [json(sprite), json({ error: "upgrade unavailable" }, 503)],
        () => runnable("upgrade").execute({}, test),
      ),
    Error,
  );
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("restart verifies identity, sends no body, and treats any success body as acceptance", async () => {
  const test = testContext(globalArgs, {
    storedResources: { state: sprite },
  });
  const { calls } = await withMockedFetch(
    [
      json(sprite),
      new Response("not SDK restart metadata", { status: 202 }),
    ],
    () => runnable("restart").execute({}, test),
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[1].method, "POST");
  assertEquals(
    calls[1].url,
    "https://api.sprites.dev/v1/sprites/demo%20sprite/restart",
  );
  assertEquals(calls[1].body, "");
});

Deno.test("restart propagates failure without retrying", async () => {
  const test = testContext(globalArgs, {
    storedResources: { state: sprite },
  });
  const { calls } = await withMockedFetch(
    [json(sprite), json({ error: "restart unavailable" }, 503)],
    () =>
      assertRejects(
        () => runnable("restart").execute({}, test),
        Error,
      ),
  );
  assertEquals(calls.length, 2);
});

Deno.test("restart refuses missing and replaced identities before POST", async () => {
  const identities: (typeof sprite | undefined)[] = [
    undefined,
    { ...sprite, id: "old-id" },
  ];
  for (const stored of identities) {
    const test = testContext(globalArgs, {
      storedResources: stored ? { state: stored } : {},
    });
    const { calls } = await withMockedFetch(
      [json(sprite)],
      () =>
        assertRejects(
          () => runnable("restart").execute({}, test),
          Error,
        ),
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET");
  }
});

Deno.test("probeUrl verifies identity then fingerprints only the provider root body", async () => {
  const probeGlobals = { ...globalArgs, name: "worker" };
  const state = {
    ...sprite,
    name: "worker",
    url: "https://worker-a1.sprites.app/",
  };
  const test = testContext(probeGlobals, {
    storedResources: { state },
  });
  const { calls } = await withMockedFetch(
    (request) => {
      if (request.url.includes("api.sprites.dev")) return json(state);
      assertEquals(request.redirect, "error");
      return new Response("hello");
    },
    () => runnable("probeUrl").execute({}, test),
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url, "https://api.sprites.dev/v1/sprites/worker");
  assertEquals(calls[1].method, "GET");
  assertEquals(calls[1].url, "https://worker-a1.sprites.app/");
  assertEquals(calls[0].headers.authorization, "Bearer test-token");
  assertEquals(calls[1].headers, { authorization: "Bearer test-token" });
  assertEquals(calls[1].body, "");
  assertEquals(test.getWrittenResources()[0].data, {
    bodyBytes: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  });
});

Deno.test("probeUrl refuses missing and replaced identities before the URL request", async () => {
  const probeGlobals = { ...globalArgs, name: "worker" };
  const state = {
    ...sprite,
    name: "worker",
    url: "https://worker-a.sprites.app/",
  };
  const identities: (typeof state | undefined)[] = [
    undefined,
    { ...state, id: "old-id" },
  ];
  for (const stored of identities) {
    const test = testContext(probeGlobals, {
      storedResources: stored ? { state: stored } : {},
    });
    const { calls } = await withMockedFetch(
      [json(state)],
      () =>
        assertRejects(
          () => runnable("probeUrl").execute({}, test),
          Error,
        ),
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "GET");
  }
});

Deno.test("probeUrl rejects non-provider root URLs before an application request", async () => {
  const probeGlobals = { ...globalArgs, name: "worker" };
  const invalidUrls = [
    "http://worker-a.sprites.app/",
    "https://other-a.sprites.app/",
    "https://worker-a.example.com/",
    "https://user:pass@worker-a.sprites.app/",
    "https://worker-a.sprites.app:444/",
    "https://worker-a.sprites.app/path",
    "https://worker-a.sprites.app/?query=yes",
    "https://worker-a.sprites.app/#fragment",
  ];
  for (const url of invalidUrls) {
    const state = { ...sprite, name: "worker", url };
    const test = testContext(probeGlobals, {
      storedResources: { state },
    });
    const { calls } = await withMockedFetch(
      [json(state)],
      () =>
        assertRejects(
          () => runnable("probeUrl").execute({}, test),
          Error,
        ),
    );
    assertEquals(calls.length, 1, url);
    assertEquals(calls[0].method, "GET", url);
  }
});

Deno.test("probeUrl enforces response size and saves no failed status", async () => {
  const probeGlobals = {
    ...globalArgs,
    name: "worker",
    maxResponseBytes: 4,
  };
  const state = {
    ...sprite,
    name: "worker",
    url: "https://worker-a.sprites.app/",
  };
  for (
    const response of [
      new Response("hello"),
      new Response("no", { status: 503 }),
    ]
  ) {
    const test = testContext(probeGlobals, {
      storedResources: { state },
    });
    await assertRejects(
      () =>
        withMockedFetch(
          [json(state), response],
          () => runnable("probeUrl").execute({}, test),
        ),
      Error,
    );
  }
});

Deno.test("probeUrl cancels a non-200 body", async () => {
  const probeGlobals = { ...globalArgs, name: "worker" };
  const state = {
    ...sprite,
    name: "worker",
    url: "https://worker-a.sprites.app/",
  };
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const test = testContext(probeGlobals, {
    storedResources: { state },
  });
  await assertRejects(
    () =>
      withMockedFetch(
        (request) =>
          request.url.includes("api.sprites.dev")
            ? json(state)
            : new Response(body, { status: 503 }),
        () => runnable("probeUrl").execute({}, test),
      ),
    Error,
  );
  assertEquals(cancelled, true);
});

Deno.test("probeUrl honors an aborted operation and writes nothing", async () => {
  const probeGlobals = { ...globalArgs, name: "worker" };
  const state = {
    ...sprite,
    name: "worker",
    url: "https://worker-a.sprites.app/",
  };
  const controller = new AbortController();
  controller.abort();
  const test = testContext(probeGlobals, {
    storedResources: { state },
  });
  await assertRejects(
    () =>
      withMockedFetch(
        [json(state), new Response("hello")],
        () =>
          runnable("probeUrl").execute({}, {
            ...test,
            globalArgs: probeGlobals,
            signal: controller.signal,
          }),
      ),
    Error,
  );
});

Deno.test("create binds the global name and sends every supported option in provider spelling", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [json(sprite, 201)],
    () =>
      runnable("create").execute({
        config: { ram_mb: 1024, cpus: 2, region: "iad", storage_gb: 20 },
        environment: { Mixed_CASE: "secret" },
        url_settings: { auth: "sprite", private_access: "org_users" },
        labels: ["ci"],
        wait_for_capacity: true,
        runtime: "dev",
      }, { ...context, globalArgs }),
  );
  assertEquals(JSON.parse(calls[0].body ?? "null"), {
    name: "demo sprite",
    config: { ram_mb: 1024, cpus: 2, region: "iad", storage_gb: 20 },
    environment: { Mixed_CASE: "secret" },
    url_settings: { auth: "sprite", private_access: "org_users" },
    labels: ["ci"],
    wait_for_capacity: true,
    runtime: "dev",
  });
});

Deno.test("filesystem requests preserve binary bytes and DELETE uses a JSON body", async () => {
  const readContext = testContext(globalArgs);
  const bytes = new Uint8Array([0, 255, 1, 128]);
  const readResult = await withMockedFetch(
    [new Response(bytes)],
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

Deno.test("NDJSON rejects provider errors, malformed events, and incomplete streams", async () => {
  for (
    const body of [
      '{"type":"error","error":"disk full","time":"2026-01-02T00:00:00Z"}\n',
      '{"type":"info","data":"working","time":"2026-01-02T00:00:00Z"}\n',
      "{broken}\n",
    ]
  ) {
    const context = testContext(globalArgs, {
      storedResources: { state: sprite },
    });
    await assertRejects(
      () =>
        withMockedFetch(
          [json(sprite), ndjson(body)],
          () =>
            runnable("createCheckpoint").execute(
              {},
              { ...context, globalArgs },
            ),
        ),
      Error,
    );
  }

  const context = testContext(globalArgs);
  const error = await assertRejects(
    () =>
      withMockedFetch(
        [ndjson('{"type":"stdout","data":"still running","timestamp":1}\n')],
        () =>
          runnable("getServiceLogs").execute(
            { service_name: "web/API" },
            { ...context, globalArgs },
          ),
      ),
    Error,
  );
  assertStringIncludes(error.message, "without a complete event");
});

Deno.test("startup exits fail even with complete, while stop and log exits remain data", async () => {
  for (
    const name of ["putService", "startService", "restartService"] as const
  ) {
    for (const code of [0, 1, 137]) {
      for (const complete of ["", '{"type":"complete","timestamp":3}\n']) {
        const test = testContext(globalArgs, {
          storedResources: { state: sprite },
        });
        const events =
          `{"type":"started","timestamp":1}\n{"type":"exit","exit_code":${code},"timestamp":2}\n${complete}`;
        await assertRejects(
          () =>
            withMockedFetch(
              [json(sprite), ndjson(events)],
              () =>
                runnable(name).execute(
                  { service_name: service.name, service },
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
    const name of ["stopService", "getServiceLogs", "restartService"] as const
  ) {
    const test = testContext(globalArgs, {
      storedResources: { state: sprite },
    });
    const event = name === "getServiceLogs" ? "exit" : "stopped";
    const events = `{"type":"${event}","exit_code":143,"timestamp":1}\n` +
      (name === "restartService" ? '{"type":"started","timestamp":2}\n' : "") +
      '{"type":"complete","timestamp":3}\n';
    await withMockedFetch(
      [...(name === "getServiceLogs" ? [] : [json(sprite)]), ndjson(events)],
      () => runnable(name).execute({ service_name: service.name }, test),
    );
    assertEquals(test.getWrittenResources().length, 1);
  }
});

Deno.test("Sprite deletion treats a missing Sprite as already deleted", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [json({ error: "missing" }, 404)],
    () => runnable("delete").execute({}, context),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
});
