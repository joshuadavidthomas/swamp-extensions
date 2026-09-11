// SPDX-License-Identifier: MIT

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { testContext } from "./_lib/test_support.ts";
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

function emptyPage(overrides: Partial<typeof emptyPageBase> = {}): Response {
  return response({ ...emptyPageBase, ...overrides });
}

Deno.test("lookup reads every page and preserves admins access", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

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
          url_settings: { auth: "sprite", private_access: "admins" },
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
        { prefix: "worker-" },
        context,
      ),
  );

  assertEquals(calls.length, 2);
  assertStringIncludes(calls[0].url, "/v1/sprites");
  assertStringIncludes(calls[0].url, "prefix=worker-");
  assertStringIncludes(calls[0].url, "max_results=500");
  assertStringIncludes(calls[1].url, "continuation_token=page-2");
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].headers.authorization, "Bearer test-token");
  assertEquals(result.dataHandles[0].name, "inventory");

  const writes = getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "inventory");

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
  assertEquals(typeof inventory.observedAt, "string");
  assertEquals(inventory.sprites, [
    {
      id: "sprite-1",
      name: "worker-1",
      organization: "acme",
      status: "running",
      created_at: "2026-09-07T12:00:00+02:00",
      updated_at: "2026-09-09T09:00:00Z",
      url: "https://worker-1.example.com",
      url_settings: { auth: "sprite", private_access: "admins" },
      labels: ["ci"],
      last_running_at: "2026-09-09T11:30:00+02:00",
    },
    {
      id: "sprite-2",
      name: "worker-2",
      organization: "acme",
      status: "cold",
      created_at: "2026-09-08T10:00:00Z",
      updated_at: "2026-09-09T10:00:00Z",
      url: "https://worker-2.example.com",
      url_settings: null,
      labels: [],
    },
  ]);
});

Deno.test("lookup discovers an empty organization with a null terminal cursor", async () => {
  const test = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [emptyPage()],
    () => model.methods.lookup.execute({}, test),
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
});

Deno.test("lookup rejects a null cursor when the API reports more pages", async () => {
  const test = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [emptyPage({ has_more: true, next_continuation_token: null })],
    () =>
      assertRejects(
        () => model.methods.lookup.execute({}, test),
        Error,
        "another page without a continuation token",
      ),
  );
  assertEquals(calls.length, 1);
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("lookup fails before writing when the API rejects the token", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [response({ error: "unauthorized" }, 401)],
        () =>
          model.methods.lookup.execute(
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "HTTP 401");
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup rejects an incomplete API page", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  let requests = 0;
  const error = await assertRejects(
    () =>
      withMockedFetch(
        () => {
          requests++;
          return response({ name: "acme" });
        },
        () =>
          model.methods.lookup.execute(
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "invalid JSON response for its schema");
  assertEquals(requests, 1);
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup rejects a repeated continuation token", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

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
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "repeated a continuation token");
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup retries transient responses, network failures, and response-body read failures", async () => {
  const failures = [
    () =>
      new Response("busy", { status: 503, headers: { "retry-after": "0" } }),
    () => {
      throw new TypeError("connection reset");
    },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.error(new Error("response interrupted"));
          },
        }),
      ),
  ];
  for (const firstFailure of failures) {
    const context = testContext(globalArgs);
    let requests = 0;
    const { calls } = await withMockedFetch(
      () => ++requests === 1 ? firstFailure() : emptyPage(),
      () => model.methods.lookup.execute({}, context),
    );
    assertEquals(calls.length, 2);
    assertEquals(context.getWrittenResources().length, 1);
  }
});

Deno.test("lookup stops after transient retries are exhausted", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;
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
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "HTTP 503");
  assertEquals(requests, 3);
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup rejects a retry delay longer than its request budget", async () => {
  const shortBudget = { ...globalArgs, timeoutMs: 1_000 };
  const context = testContext(shortBudget);
  const { getWrittenResources } = context;
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
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "longer than timeoutMs");
  assertEquals(requests, 1);
  assertEquals(getWrittenResources(), []);
});

Deno.test("lookup honors parent cancellation without retrying", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const context = testContext(globalArgs, { signal: controller.signal });
  const { getWrittenResources } = context;
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
            {},
            context,
          ),
      ),
    DOMException,
  );

  assertEquals(error.name, "AbortError");
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
  const test = testContext(limited);
  let requests = 0;
  const error = await assertRejects(() =>
    withMockedFetch(() => {
      requests++;
      return requests === 1 ? response(first) : emptyPage();
    }, () => model.methods.lookup.execute({}, test)), Error);
  assertStringIncludes(error.message, "maxResponseBytes");
  assertEquals(requests, 2);
  assertEquals(test.getWrittenResources(), []);
});
