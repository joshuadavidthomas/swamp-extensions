// SPDX-License-Identifier: MIT

import {
  assertEquals,
  assertIsError,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createModelTestContext,
  withMockedFetch,
} from "@swamp-club/swamp-testing";
import { model } from "./organization.ts";

const globalArgs = {
  token: "test-token",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 67_108_864,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptyPageBase = {
  sprites: [],
  has_more: false,
  next_continuation_token: null as string | null,
  name: "acme",
  running: 0,
  warm: 0,
  cold: 0,
};
type EmptyPage = typeof emptyPageBase;

function emptyPage(overrides: Partial<EmptyPage> = {}): Response {
  return response({ ...emptyPageBase, ...overrides });
}

const privateAccess = "admins";
Deno.test(`lookup reads every page and preserves ${privateAccess} access`, async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "lookup",
  });

  const { result, calls } = await withMockedFetch(
    (request) => {
      if (request.url.includes("continuation_token=page-2")) {
        return response({
          sprites: [{
            id: "sprite-2",
            name: "worker-2",
            organization: "acme",
            status: "cold",
            created_at: "2026-09-08T10:00:00Z",
            updated_at: "2026-09-09T10:00:00Z",
            url: "https://worker-2.example.com",
            url_settings: null,
            labels: [],
          }],
          has_more: false,
          next_continuation_token: null,
          name: "acme",
          running: 0,
          warm: 0,
          cold: 1,
        });
      }

      return response({
        sprites: [{
          id: "sprite-1",
          name: "worker-1",
          organization: "acme",
          status: "running",
          created_at: "2026-09-07T12:00:00+02:00",
          updated_at: "2026-09-09T09:00:00Z",
          url: "https://worker-1.example.com",
          url_settings: { auth: "sprite", private_access: privateAccess },
          labels: ["ci"],
          last_running_at: "2026-09-09T11:30:00+02:00",
        }],
        has_more: true,
        next_continuation_token: "page-2",
        name: "acme",
        running: 1,
        warm: 0,
        cold: 0,
        running_limit: 5,
        warm_limit: 10,
      });
    },
    () =>
      model.methods.lookup.execute(
        { prefix: "worker-", pageSize: 2 },
        { ...context, deleteResource: async () => {}, globalArgs },
      ),
  );

  assertEquals(calls.length, 2);
  assertStringIncludes(calls[0].url, "/v1/sprites");
  assertStringIncludes(calls[0].url, "prefix=worker-");
  assertStringIncludes(calls[0].url, "max_results=2");
  assertStringIncludes(calls[1].url, "continuation_token=page-2");
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].headers.authorization, "Bearer test-token");
  assertEquals(result.dataHandles[0].name, "inventory");

  const writes = getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "inventory");
  assertEquals(writes[0].name, "inventory");

  const inventory = writes[0].data;
  assertEquals(inventory.organization, {
    name: "acme",
    runningLimit: 5,
    warmLimit: 10,
  });
  assertEquals(inventory.counts, {
    total: 2,
    running: 1,
    warm: 0,
    cold: 1,
  });
  assertEquals(inventory.prefix, "worker-");
  assertEquals(inventory.truncated, false);
  assertEquals(typeof inventory.observedAt, "string");
  assertEquals(inventory.sprites, [
    {
      id: "sprite-1",
      name: "worker-1",
      organization: "acme",
      status: "running",
      createdAt: "2026-09-07T12:00:00+02:00",
      updatedAt: "2026-09-09T09:00:00Z",
      url: "https://worker-1.example.com",
      urlSettings: { auth: "sprite", privateAccess },
      version: null,
      environmentVersion: null,
      labels: ["ci"],
      lastRunningAt: "2026-09-09T11:30:00+02:00",
      lastWarmingAt: null,
    },
    {
      id: "sprite-2",
      name: "worker-2",
      organization: "acme",
      status: "cold",
      createdAt: "2026-09-08T10:00:00Z",
      updatedAt: "2026-09-09T10:00:00Z",
      url: "https://worker-2.example.com",
      urlSettings: null,
      version: null,
      environmentVersion: null,
      labels: [],
      lastRunningAt: null,
      lastWarmingAt: null,
    },
  ]);
});

Deno.test("lookup discovers an empty organization with a null terminal cursor", async () => {
  const test = createModelTestContext({ globalArgs });
  const { calls } = await withMockedFetch(
    [emptyPage({ next_continuation_token: null })],
    () =>
      model.methods.lookup.execute({ pageSize: 500 }, {
        ...test.context,
        deleteResource: async () => {},
        globalArgs,
      }),
  );
  assertEquals(calls.length, 1);
  const inventory = test.getWrittenResources()[0].data;
  assertEquals(inventory.organization, {
    name: "acme",
    runningLimit: null,
    warmLimit: null,
  });
  assertEquals(inventory.counts, { total: 0, running: 0, warm: 0, cold: 0 });
  assertEquals(inventory.sprites, []);
  assertEquals(inventory.truncated, false);
});

Deno.test("lookup rejects a null cursor when the API reports more pages", async () => {
  const test = createModelTestContext({ globalArgs });
  const { calls, result: error } = await withMockedFetch(
    [emptyPage({ has_more: true, next_continuation_token: null })],
    () =>
      assertRejects(
        () =>
          model.methods.lookup.execute({ pageSize: 500 }, {
            ...test.context,
            deleteResource: async () => {},
            globalArgs,
          }),
        Error,
        "Could not read Sprites organization inventory",
      ),
  );
  assertIsError(error.cause);
  assertStringIncludes(
    error.cause.message,
    "another page without a continuation token",
  );
  assertEquals(calls.length, 1);
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("lookup fails before writing when the API rejects the token", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [response({ error: "unauthorized" }, 401)],
        () =>
          model.methods.lookup.execute(
            { pageSize: 500 },
            { ...context, deleteResource: async () => {}, globalArgs },
          ),
      ),
    Error,
  );

  assertStringIncludes(
    error.message,
    "Could not read Sprites organization inventory",
  );
  assertIsError(error.cause);
  assertStringIncludes(error.cause.message, "HTTP 401");
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup rejects an incomplete API page", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [response({ name: "acme" })],
        () =>
          model.methods.lookup.execute(
            { pageSize: 500 },
            { ...context, deleteResource: async () => {}, globalArgs },
          ),
      ),
    Error,
  );

  assertIsError(error.cause);
  assertStringIncludes(error.cause.message, "unexpected list response");
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup rejects a repeated continuation token", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [
          emptyPage({
            has_more: true,
            next_continuation_token: "repeated",
          }),
          emptyPage({
            has_more: true,
            next_continuation_token: "repeated",
          }),
        ],
        () =>
          model.methods.lookup.execute(
            { pageSize: 500 },
            { ...context, deleteResource: async () => {}, globalArgs },
          ),
      ),
    Error,
  );

  assertIsError(error.cause);
  assertStringIncludes(error.cause.message, "repeated a continuation token");
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup retries a transient response", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });

  const { calls } = await withMockedFetch(
    [
      new Response("busy", {
        status: 503,
        headers: { "retry-after": "0" },
      }),
      emptyPage(),
    ],
    () =>
      model.methods.lookup.execute(
        { pageSize: 500 },
        { ...context, deleteResource: async () => {}, globalArgs },
      ),
  );

  assertEquals(calls.length, 2);
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("lookup retries a network failure", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  let requests = 0;

  const { calls } = await withMockedFetch(
    () => {
      requests += 1;
      if (requests === 1) {
        throw new TypeError("connection reset");
      }
      return emptyPage();
    },
    () =>
      model.methods.lookup.execute(
        { pageSize: 500 },
        { ...context, deleteResource: async () => {}, globalArgs },
      ),
  );

  assertEquals(calls.length, 2);
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("lookup retries a response-body read failure", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  let requests = 0;

  const { calls } = await withMockedFetch(
    () => {
      requests += 1;
      if (requests === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.error(new Error("response interrupted"));
            },
          }),
        );
      }
      return emptyPage();
    },
    () =>
      model.methods.lookup.execute(
        { pageSize: 500 },
        { ...context, deleteResource: async () => {}, globalArgs },
      ),
  );

  assertEquals(calls.length, 2);
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("lookup stops after transient retries are exhausted", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  let requests = 0;

  const error = await assertRejects(
    () =>
      withMockedFetch(
        () => {
          requests += 1;
          return new Response("busy", {
            status: 503,
            headers: { "retry-after": "0" },
          });
        },
        () =>
          model.methods.lookup.execute(
            { pageSize: 500 },
            { ...context, deleteResource: async () => {}, globalArgs },
          ),
      ),
    Error,
  );

  assertIsError(error.cause);
  assertStringIncludes(error.cause.message, "HTTP 503");
  assertEquals(requests, 3);
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup rejects a retry delay longer than its request budget", async () => {
  const shortBudget = { ...globalArgs, timeoutMs: 1_000 };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: shortBudget,
  });
  let requests = 0;

  const error = await assertRejects(
    () =>
      withMockedFetch(
        () => {
          requests += 1;
          return new Response("busy", {
            status: 503,
            headers: { "retry-after": "2" },
          });
        },
        () =>
          model.methods.lookup.execute(
            { pageSize: 500 },
            {
              ...context,
              deleteResource: async () => {},
              globalArgs: shortBudget,
            },
          ),
      ),
    Error,
  );

  assertIsError(error.cause);
  assertStringIncludes(error.cause.message, "longer than timeoutMs");
  assertEquals(requests, 1);
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup honors parent cancellation without retrying", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    signal: controller.signal,
  });
  let requests = 0;

  const error = await assertRejects(
    () =>
      withMockedFetch(
        (request) => {
          requests += 1;
          if (request.signal.aborted) {
            throw request.signal.reason;
          }
          return emptyPage();
        },
        () =>
          model.methods.lookup.execute(
            { pageSize: 500 },
            { ...context, deleteResource: async () => {}, globalArgs },
          ),
      ),
    Error,
  );

  assertIsError(error.cause);
  assertStringIncludes(error.cause.message, "request failed");
  assertEquals(requests, 1);
  assertEquals(getWrittenResources(), []);
});

Deno.test("inventory enforces one aggregate byte budget across all pages without retrying oversize data", async () => {
  const first = {
    sprites: [],
    has_more: true,
    next_continuation_token: "next",
    name: "acme",
    running: 0,
    warm: 0,
    cold: 0,
  };
  const limited = {
    ...globalArgs,
    maxResponseBytes: new TextEncoder().encode(JSON.stringify(first)).length +
      1,
  };
  const test = createModelTestContext({ globalArgs: limited });
  let requests = 0;
  const error = await assertRejects(() =>
    withMockedFetch(() => {
      requests++;
      return requests === 1 ? response(first) : emptyPage();
    }, () =>
      model.methods.lookup.execute({ pageSize: 500 }, {
        ...test.context,
        deleteResource: async () => {},
        globalArgs: limited,
      })), Error);
  assertIsError(error.cause);
  assertIsError(error.cause.cause);
  assertStringIncludes(error.cause.cause.message, "maxResponseBytes");
  assertEquals(requests, 2);
  assertEquals(test.getWrittenResources(), []);
});
