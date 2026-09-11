// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  globalArgs,
  json,
  noContent,
  registerRouteCases,
  type RouteCase,
  runnable,
  sprite,
  testContext,
} from "./test_support.ts";

const routeCases: RouteCase[] = [
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
];

registerRouteCases(routeCases);

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
    assertEquals(calls.length, stored ? 1 : 0);
    if (stored) assertEquals(calls[0].method, "GET");
  }
});

Deno.test("probeUrl verifies identity then fingerprints only the provider root body", async () => {
  const state = {
    ...sprite,
    name: "worker",
    url: "https://worker-a1.sprites.app/",
  };
  const test = testContext({ ...globalArgs, name: "worker" }, {
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
    const test = testContext({ ...globalArgs, name: "worker" }, {
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
    assertEquals(calls.length, stored ? 1 : 0);
    if (stored) assertEquals(calls[0].method, "GET");
  }
});

Deno.test("probeUrl rejects non-provider root URLs before an application request", async () => {
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
    const test = testContext({ ...globalArgs, name: "worker" }, {
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
    const test = testContext({
      ...globalArgs,
      name: "worker",
      maxResponseBytes: 4,
    }, {
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
  const test = testContext({ ...globalArgs, name: "worker" }, {
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

Deno.test("Sprite deletion treats a missing Sprite as already deleted", async () => {
  const context = testContext(globalArgs, {
    storedResources: { state: sprite },
  });
  const { calls } = await withMockedFetch(
    [json({ error: "missing" }, 404)],
    () => runnable("delete").execute({}, context),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
});

Deno.test("Sprite create refuses an already bound instance without a request", async () => {
  const test = testContext(globalArgs, { storedResources: { state: sprite } });
  const { calls } = await withMockedFetch(
    [],
    () =>
      assertRejects(
        () => runnable("create").execute({}, test),
        Error,
        "already saved",
      ),
  );
  assertEquals(calls.length, 0);
  assertEquals(test.getWrittenResources(), []);
});
