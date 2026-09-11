// SPDX-License-Identifier: MIT

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.14";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { testContext } from "./_lib/test_support.ts";
import { model } from "./organization.ts";
import { type ManagementExec } from "./_lib/local-api.ts";

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

Deno.test("listSprites reads every page and preserves admins access", async () => {
  const context = testContext(globalArgs);

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
      model.methods.listSprites.execute(
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
  assertEquals(result.dataHandles[0].name, "listSprites");

  const writes = context.getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "listSprites");

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

Deno.test("listSprites discovers an empty organization with a null terminal cursor", async () => {
  const test = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [emptyPage()],
    () => model.methods.listSprites.execute({}, test),
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

Deno.test("listSprites rejects a null cursor when the API reports more pages", async () => {
  const test = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [emptyPage({ has_more: true, next_continuation_token: null })],
    () =>
      assertRejects(
        () => model.methods.listSprites.execute({}, test),
        Error,
        "another page without a continuation token",
      ),
  );
  assertEquals(calls.length, 1);
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("listSprites fails before writing when the API rejects the token", async () => {
  const context = testContext(globalArgs);

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [response({ error: "unauthorized" }, 401)],
        () =>
          model.methods.listSprites.execute(
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "HTTP 401");
  assertEquals(context.getWrittenResources(), []);
});

Deno.test("listSprites rejects an incomplete API page", async () => {
  const context = testContext(globalArgs);

  let requests = 0;
  const error = await assertRejects(
    () =>
      withMockedFetch(
        () => {
          requests++;
          return response({ name: "acme" });
        },
        () =>
          model.methods.listSprites.execute(
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "invalid JSON response for its schema");
  assertEquals(requests, 1);
  assertEquals(context.getWrittenResources(), []);
});

Deno.test("listSprites rejects a repeated continuation token", async () => {
  const context = testContext(globalArgs);

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
          model.methods.listSprites.execute(
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "repeated a continuation token");
  assertEquals(context.getWrittenResources(), []);
});

Deno.test("listSprites retries transient responses, network failures, and response-body read failures", async () => {
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
      () => model.methods.listSprites.execute({}, context),
    );
    assertEquals(calls.length, 2);
    assertEquals(context.getWrittenResources().length, 1);
  }
});

Deno.test("listSprites stops after transient retries are exhausted", async () => {
  const context = testContext(globalArgs);
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
          model.methods.listSprites.execute(
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "HTTP 503");
  assertEquals(requests, 3);
  assertEquals(context.getWrittenResources(), []);
});

Deno.test("listSprites rejects a retry delay longer than its request budget", async () => {
  const context = testContext({ ...globalArgs, timeoutMs: 1_000 });
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
          model.methods.listSprites.execute(
            {},
            context,
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "longer than timeoutMs");
  assertEquals(requests, 1);
  assertEquals(context.getWrittenResources(), []);
});

Deno.test("listSprites honors parent cancellation without retrying", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const context = testContext(globalArgs, { signal: controller.signal });
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
          model.methods.listSprites.execute(
            {},
            context,
          ),
      ),
    DOMException,
  );

  assertEquals(error.name, "AbortError");
  assertEquals(requests, 1);
  assertEquals(context.getWrittenResources(), []);
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
    }, () => model.methods.listSprites.execute({}, test)), Error);
  assertStringIncludes(error.message, "maxResponseBytes");
  assertEquals(requests, 2);
  assertEquals(test.getWrittenResources(), []);
});

const policy = {
  allow_all: false,
  sprite_labels: ["production", "worker"],
  name_prefix: "jobs-",
  allowed_endpoints: ["/chat.postMessage", "/chat.*"],
  blocked_endpoints: ["/chat.delete"],
};

const connectionBase = {
  id: "connection-1",
  provider: "slack",
  provider_account_id: "team-1",
  provider_account_name: "Acme",
  scopes: "chat:write,channels:read" as string | null,
  connection_type: "oauth",
  access_policy: policy,
  provider_info: {
    icon: "speech-bubble",
    nested: { color: "aubergine", flags: [true, null, 3] },
  },
  user_id: "user-1" as string | null,
  token_expires_at: "2026-09-10T12:00:00Z",
  inserted_at: "2026-09-09T10:00:00Z",
  updated_at: "2026-09-09T11:00:00Z",
  usage_snippet: "fetch('/v1/gateway/slack/connection-1/...')",
};

function connection(overrides: Partial<typeof connectionBase> = {}) {
  return { ...connectionBase, ...overrides };
}

Deno.test("list routes provider filtering and retains open provider_info metadata", async () => {
  const context = testContext(globalArgs);

  const { result, calls } = await withMockedFetch(
    [response({ connections: [connection()] })],
    () =>
      model.methods.listConnectors.execute(
        { provider: "slack" },
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/v1/oauth/connections");
  assertEquals(url.searchParams.get("provider"), "slack");
  assertEquals(
    calls[0].headers.authorization,
    "Bearer test-token",
  );
  assertEquals(result.dataHandles.length, 1);
  const writes = context.getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "listConnectors");
  assertEquals(writes[0].data, {
    connections: [connection()],
  });
});

Deno.test("list omits the optional provider query field", async () => {
  const context = testContext(globalArgs);

  const { calls } = await withMockedFetch(
    [response({ connections: [] })],
    () => model.methods.listConnectors.execute({}, context),
  );

  assertEquals(new URL(calls[0].url).search, "");
});

Deno.test("invalid API output fails without writing a resource", async () => {
  const context = testContext(globalArgs);

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [response({ connections: [{ id: "incomplete" }] })],
        () => model.methods.listConnectors.execute({}, context),
      ),
    Error,
  );

  assertStringIncludes(error.message, "invalid JSON response");
  assertEquals(context.getWrittenResources(), []);
});

const getNetworkPolicy = {
  rules: [{ domain: "example.com", action: "allow" as const }],
};

function rolloutSprite(index: number, labels?: string[]) {
  return {
    id: `sprite-${index}`,
    name: `worker-${index}`,
    organization: "acme",
    status: "cold",
    created_at: "2026-09-08T10:00:00Z",
    updated_at: "2026-09-09T10:00:00Z",
    url: `https://worker-${index}.example.com`,
    labels,
  };
}

Deno.test("setNetworkPolicy selects by API prefix across pages and applies in listing order", async () => {
  const context = testContext(globalArgs);
  const bodies: unknown[] = [];
  const { result, calls } = await withMockedFetch(
    async (request) => {
      if (request.method === "POST") {
        bodies.push(await request.json());
        return new Response(null, { status: 204 });
      }
      const second = new URL(request.url).searchParams.has(
        "continuation_token",
      );
      return response({
        ...emptyPageBase,
        sprites: [rolloutSprite(second ? 2 : 1)],
        has_more: !second,
        next_continuation_token: second ? null : "next",
      });
    },
    () =>
      model.methods.setNetworkPolicy.execute({
        select: { prefix: "worker-" },
        policy: getNetworkPolicy,
      }, context),
  );
  assertEquals(calls.map((call) => call.method), [
    "GET",
    "GET",
    "POST",
    "POST",
  ]);
  for (const call of calls.slice(0, 2)) {
    assertEquals(new URL(call.url).searchParams.get("prefix"), "worker-");
  }
  assertEquals(calls.slice(2).map((call) => new URL(call.url).pathname), [
    "/v1/sprites/worker-1/policy/network",
    "/v1/sprites/worker-2/policy/network",
  ]);
  assertEquals(bodies, [getNetworkPolicy, getNetworkPolicy]);
  assertEquals(result.dataHandles.map((handle) => handle.name), [
    "setNetworkPolicy-sprite-1",
    "setNetworkPolicy-sprite-2",
    "setNetworkPolicy",
  ]);
  const writes = context.getWrittenResources();
  assertEquals(writes.length, 3);
  assertEquals(writes[2].specName, "setNetworkPolicy");
  assertEquals(writes[2].data, {
    select: { prefix: "worker-" },
    matched: 2,
    applied: 2,
    failed: 0,
    results: [1, 2].map((index) => ({
      name: `worker-${index}`,
      id: `sprite-${index}`,
      status: "applied",
      policy: getNetworkPolicy,
    })),
    observedAt: writes[2].data.observedAt,
  });
  assertEquals(typeof writes[2].data.observedAt, "string");
  for (const [offset, index] of [1, 2].entries()) {
    assertEquals(writes[offset].specName, "spriteSetNetworkPolicy");
    assertEquals(writes[offset].name, `setNetworkPolicy-sprite-${index}`);
    assertEquals(writes[offset].data, {
      name: `worker-${index}`,
      id: `sprite-${index}`,
      status: "applied",
      policy: getNetworkPolicy,
      observedAt: writes[2].data.observedAt,
    });
  }
});

Deno.test("setNetworkPolicy requires every selected label", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [
      response({
        ...emptyPageBase,
        sprites: [
          rolloutSprite(1, ["ci", "prod"]),
          rolloutSprite(2, ["ci"]),
          rolloutSprite(3),
          rolloutSprite(4, ["prod", "ci", "extra"]),
        ],
      }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ],
    () =>
      model.methods.setNetworkPolicy.execute({
        select: { labels: ["ci", "prod"] },
        policy: getNetworkPolicy,
      }, context),
  );
  assertEquals(calls.map((call) => new URL(call.url).pathname), [
    "/v1/sprites",
    "/v1/sprites/worker-1/policy/network",
    "/v1/sprites/worker-4/policy/network",
  ]);
  const rollout = context.getWrittenResources().at(-1)!.data;
  assertEquals(rollout.matched, 2);
  assertEquals(rollout.select, { labels: ["ci", "prod"] });
});

Deno.test("setNetworkPolicy all omits prefix and records a failure without retrying or stopping", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [
      response({
        ...emptyPageBase,
        sprites: [1, 2, 3].map((index) => rolloutSprite(index)),
      }),
      new Response(null, { status: 204 }),
      response({ error: "private provider output" }, 500),
      new Response(null, { status: 204 }),
    ],
    () =>
      model.methods.setNetworkPolicy.execute({
        select: { all: true },
        policy: getNetworkPolicy,
      }, context),
  );
  assertEquals(new URL(calls[0].url).searchParams.has("prefix"), false);
  assertEquals(calls.map((call) => call.method), [
    "GET",
    "POST",
    "POST",
    "POST",
  ]);
  assertEquals(
    calls.slice(1).map((call) => new URL(call.url).pathname),
    [1, 2, 3].map((index) => `/v1/sprites/worker-${index}/policy/network`),
  );
  const rollout = context.getWrittenResources().at(-1)!.data;
  assertEquals(rollout.matched, 3);
  assertEquals(rollout.applied, 2);
  assertEquals(rollout.failed, 1);
  assertEquals(rollout.results, [
    {
      name: "worker-1",
      id: "sprite-1",
      status: "applied",
      policy: getNetworkPolicy,
    },
    { name: "worker-2", id: "sprite-2", status: "failed", error: "HTTP 500" },
    {
      name: "worker-3",
      id: "sprite-3",
      status: "applied",
      policy: getNetworkPolicy,
    },
  ]);
  const failed = context.getWrittenResources()[1];
  assertEquals(failed.specName, "spriteSetNetworkPolicy");
  assertEquals(failed.name, "setNetworkPolicy-sprite-2");
  assertEquals(failed.data, {
    name: "worker-2",
    id: "sprite-2",
    status: "failed",
    error: "HTTP 500",
    observedAt: rollout.observedAt,
  });
});

Deno.test("setNetworkPolicy hides unsanitized response-body cancellation errors", async () => {
  const context = testContext(globalArgs);
  await withMockedFetch(
    (request) =>
      request.method === "GET"
        ? response({ ...emptyPageBase, sprites: [rolloutSprite(1)] })
        : new Response(
          new ReadableStream({
            cancel() {
              throw new Error("private provider output");
            },
          }),
        ),
    () =>
      model.methods.setNetworkPolicy.execute({
        select: { all: true },
        policy: getNetworkPolicy,
      }, context),
  );
  assertEquals(context.getWrittenResources().at(-1)!.data.results, [
    {
      name: "worker-1",
      id: "sprite-1",
      status: "failed",
      error: "request failed",
    },
  ]);
});

Deno.test("setNetworkPolicy parent cancellation mid-rollout preserves completed rows without a summary", async () => {
  const controller = new AbortController();
  const context = testContext(globalArgs, { signal: controller.signal });
  let posts = 0;
  const { calls } = await withMockedFetch(
    (request) => {
      if (request.method === "GET") {
        return response({
          ...emptyPageBase,
          sprites: [1, 2, 3].map((index) => rolloutSprite(index)),
        });
      }
      if (++posts === 2) {
        controller.abort(new DOMException("cancelled", "AbortError"));
        throw request.signal.reason;
      }
      return new Response(null, { status: 204 });
    },
    () =>
      assertRejects(
        () =>
          model.methods.setNetworkPolicy.execute({
            select: { all: true },
            policy: getNetworkPolicy,
          }, context),
        DOMException,
        "cancelled",
      ),
  );
  assertEquals(calls.map((call) => call.method), ["GET", "POST", "POST"]);
  const writes = context.getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "spriteSetNetworkPolicy");
  assertEquals(writes[0].name, "setNetworkPolicy-sprite-1");
  assertEquals(writes[0].data, {
    name: "worker-1",
    id: "sprite-1",
    status: "applied",
    policy: getNetworkPolicy,
    observedAt: writes[0].data.observedAt,
  });
  assertEquals(typeof writes[0].data.observedAt, "string");
});

Deno.test("setPrivilegesPolicy posts the policy and records the rollout and Sprite outcome", async () => {
  const context = testContext(globalArgs);
  const policy = {
    profile: "minimal" as const,
    devices: ["/dev/null"],
    noNewPrivileges: true,
  };
  const bodies: unknown[] = [];
  const { result, calls } = await withMockedFetch(
    async (request) => {
      if (request.method === "POST") {
        bodies.push(await request.json());
        return new Response(null, { status: 204 });
      }
      return response({ ...emptyPageBase, sprites: [rolloutSprite(1)] });
    },
    () =>
      model.methods.setPrivilegesPolicy.execute({
        select: { all: true },
        policy,
      }, context),
  );
  assertEquals(calls.map((call) => call.method), ["GET", "POST"]);
  assertEquals(
    new URL(calls[1].url).pathname,
    "/v1/sprites/worker-1/policy/privileges",
  );
  assertEquals(bodies, [policy]);
  assertEquals(result.dataHandles.map((handle) => handle.name), [
    "setPrivilegesPolicy-sprite-1",
    "setPrivilegesPolicy",
  ]);
  const writes = context.getWrittenResources();
  assertEquals(writes.length, 2);
  assertEquals(writes[1].specName, "setPrivilegesPolicy");
  assertEquals(writes[1].name, "setPrivilegesPolicy");
  const summary = model.resources.setPrivilegesPolicy.schema.parse(
    writes[1].data,
  );
  assertEquals(writes.at(-1)!.data, summary);
  assertEquals(summary, {
    select: { all: true },
    matched: 1,
    applied: 1,
    failed: 0,
    results: [{
      name: "worker-1",
      id: "sprite-1",
      status: "applied",
      policy,
    }],
    observedAt: summary.observedAt,
  });
  assertEquals(writes[0].specName, "spriteSetPrivilegesPolicy");
  assertEquals(writes[0].name, "setPrivilegesPolicy-sprite-1");
  assertEquals(writes[0].data, {
    name: "worker-1",
    id: "sprite-1",
    status: "applied",
    policy,
    observedAt: summary.observedAt,
  });
});

Deno.test("setResourcesPolicy posts the policy and records the rollout and Sprite outcome", async () => {
  const context = testContext(globalArgs);
  const policy = { memory: { limit_mb: 1024, autoscale: false } };
  const bodies: unknown[] = [];
  const { result, calls } = await withMockedFetch(
    async (request) => {
      if (request.method === "POST") {
        bodies.push(await request.json());
        return new Response(null, { status: 204 });
      }
      return response({ ...emptyPageBase, sprites: [rolloutSprite(1)] });
    },
    () =>
      model.methods.setResourcesPolicy.execute({
        select: { all: true },
        policy,
      }, context),
  );
  assertEquals(calls.map((call) => call.method), ["GET", "POST"]);
  assertEquals(
    new URL(calls[1].url).pathname,
    "/v1/sprites/worker-1/policy/resources",
  );
  assertEquals(bodies, [policy]);
  assertEquals(result.dataHandles.map((handle) => handle.name), [
    "setResourcesPolicy-sprite-1",
    "setResourcesPolicy",
  ]);
  const writes = context.getWrittenResources();
  assertEquals(writes.length, 2);
  assertEquals(writes[1].specName, "setResourcesPolicy");
  assertEquals(writes[1].name, "setResourcesPolicy");
  const summary = model.resources.setResourcesPolicy.schema.parse(
    writes[1].data,
  );
  assertEquals(writes.at(-1)!.data, summary);
  assertEquals(summary, {
    select: { all: true },
    matched: 1,
    applied: 1,
    failed: 0,
    results: [{
      name: "worker-1",
      id: "sprite-1",
      status: "applied",
      policy,
    }],
    observedAt: summary.observedAt,
  });
  assertEquals(writes[0].specName, "spriteSetResourcesPolicy");
  assertEquals(writes[0].name, "setResourcesPolicy-sprite-1");
  assertEquals(writes[0].data, {
    name: "worker-1",
    id: "sprite-1",
    status: "applied",
    policy,
    observedAt: summary.observedAt,
  });
});

Deno.test("deletePrivilegesPolicy removes policies in order and records an absent policy as a failure", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    (request) => {
      if (request.method === "GET") {
        return response({
          ...emptyPageBase,
          sprites: [rolloutSprite(1), rolloutSprite(2)],
        });
      }
      assertEquals(request.body, null);
      return new URL(request.url).pathname.includes("worker-2")
        ? response({ error: "policy absent" }, 404)
        : new Response(null, { status: 204 });
    },
    () =>
      model.methods.deletePrivilegesPolicy.execute({
        select: { all: true },
      }, context),
  );
  assertEquals(calls.map((call) => call.method), ["GET", "DELETE", "DELETE"]);
  assertEquals(calls.slice(1).map((call) => new URL(call.url).pathname), [
    "/v1/sprites/worker-1/policy/privileges",
    "/v1/sprites/worker-2/policy/privileges",
  ]);
  const writes = context.getWrittenResources();
  assertEquals(writes.length, 3);
  assertEquals(writes[2].specName, "deletePrivilegesPolicy");
  assertEquals(writes[2].name, "deletePrivilegesPolicy");
  const summary = model.resources.deletePrivilegesPolicy.schema.parse(
    writes[2].data,
  );
  const results: typeof summary.results = [
    {
      name: "worker-1",
      id: "sprite-1",
      status: "applied",
    },
    { name: "worker-2", id: "sprite-2", status: "failed", error: "HTTP 404" },
  ];
  assertEquals(writes.at(-1)!.data, summary);
  assertEquals(summary, {
    select: { all: true },
    matched: 2,
    applied: 1,
    failed: 1,
    results,
    observedAt: summary.observedAt,
  });
  for (const [index, result] of results.entries()) {
    assertEquals(writes[index].specName, "spriteDeletePrivilegesPolicy");
    assertEquals(writes[index].name, `deletePrivilegesPolicy-${result.id}`);
    assertEquals(writes[index].data, {
      ...result,
      observedAt: summary.observedAt,
    });
  }
});

Deno.test("deleteResourcesPolicy uses the resources route and record names", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [
      response({ ...emptyPageBase, sprites: [rolloutSprite(1)] }),
      new Response(null, { status: 204 }),
    ],
    () =>
      model.methods.deleteResourcesPolicy.execute({
        select: { all: true },
      }, context),
  );
  assertEquals(calls.map((call) => call.method), ["GET", "DELETE"]);
  assertEquals(
    new URL(calls[1].url).pathname,
    "/v1/sprites/worker-1/policy/resources",
  );
  assertEquals(
    context.getWrittenResources().map(({ specName, name }) => ({
      specName,
      name,
    })),
    [
      {
        specName: "spriteDeleteResourcesPolicy",
        name: "deleteResourcesPolicy-sprite-1",
      },
      { specName: "deleteResourcesPolicy", name: "deleteResourcesPolicy" },
    ],
  );
  const writes = context.getWrittenResources();
  const summary = model.resources.deleteResourcesPolicy.schema.parse(
    writes[1].data,
  );
  const row = {
    name: "worker-1",
    id: "sprite-1",
    status: "applied",
  };
  assertEquals(writes[1].data, {
    select: { all: true },
    matched: 1,
    applied: 1,
    failed: 0,
    results: [row],
    observedAt: summary.observedAt,
  });
  assertEquals(writes[0].data, { ...row, observedAt: summary.observedAt });
});

Deno.test("getNetworkPolicy reads each current policy into the summary and method records", async () => {
  const context = testContext(globalArgs);
  const policies = [getNetworkPolicy, {
    rules: [{ domain: "blocked.example", action: "deny" }],
  }];
  const { result, calls } = await withMockedFetch(
    [
      response({
        ...emptyPageBase,
        sprites: [rolloutSprite(1), rolloutSprite(2)],
      }),
      ...policies.map((policy) => response(policy)),
    ],
    () =>
      model.methods.getNetworkPolicy.execute(
        { select: { all: true } },
        context,
      ),
  );
  assertEquals(calls.map((call) => call.method), ["GET", "GET", "GET"]);
  assertEquals(calls.map((call) => new URL(call.url).pathname), [
    "/v1/sprites",
    "/v1/sprites/worker-1/policy/network",
    "/v1/sprites/worker-2/policy/network",
  ]);
  assertEquals(result.dataHandles.map((handle) => handle.name), [
    "getNetworkPolicy-sprite-1",
    "getNetworkPolicy-sprite-2",
    "getNetworkPolicy",
  ]);
  const writes = context.getWrittenResources();
  const audit = model.resources.getNetworkPolicy.schema.parse(writes[2].data);
  const results = policies.map((policy, index) => ({
    name: `worker-${index + 1}`,
    id: `sprite-${index + 1}`,
    status: "applied",
    policy,
  }));
  assertEquals(writes[2].specName, "getNetworkPolicy");
  assertEquals(audit, {
    select: { all: true },
    matched: 2,
    applied: 2,
    failed: 0,
    results,
    observedAt: audit.observedAt,
  });
  for (const [index, row] of results.entries()) {
    assertEquals(writes[index].specName, "spriteGetNetworkPolicy");
    assertEquals(writes[index].name, `getNetworkPolicy-sprite-${index + 1}`);
    assertEquals(writes[index].data, { ...row, observedAt: audit.observedAt });
  }
});

Deno.test("upgrade posts with and without a version and records provider acceptance", async () => {
  for (const version of ["2026.09.11", undefined]) {
    const context = testContext(globalArgs);
    const bodies: string[] = [];
    const { result, calls } = await withMockedFetch(
      async (request) => {
        if (request.method === "GET") {
          return response({
            ...emptyPageBase,
            sprites: [rolloutSprite(1), rolloutSprite(2)],
          });
        }
        bodies.push(await request.text());
        return new Response(null, { status: 204 });
      },
      () =>
        model.methods.upgrade.execute(
          { select: { all: true }, version },
          context,
        ),
    );
    assertEquals(calls.map((call) => call.method), ["GET", "POST", "POST"]);
    assertEquals(calls.slice(1).map((call) => new URL(call.url).pathname), [
      "/v1/sprites/worker-1/upgrade",
      "/v1/sprites/worker-2/upgrade",
    ]);
    assertEquals(
      bodies,
      [1, 2].map(() => version ? JSON.stringify({ version }) : ""),
    );
    assertEquals(result.dataHandles.map((handle) => handle.name), [
      "upgrade-sprite-1",
      "upgrade-sprite-2",
      "upgrade",
    ]);
    const writes = context.getWrittenResources();
    const summary = model.resources.upgrade.schema.parse(writes[2].data);
    const results = [1, 2].map((index) => ({
      name: `worker-${index}`,
      id: `sprite-${index}`,
      status: "applied",
      version: version ?? null,
    }));
    assertEquals(writes[2].specName, "upgrade");
    assertEquals(writes.at(-1)!.data, summary);
    assertEquals(summary, {
      select: { all: true },
      matched: 2,
      applied: 2,
      failed: 0,
      results,
      observedAt: summary.observedAt,
    });
    for (const [index, row] of results.entries()) {
      assertEquals(writes[index].specName, "spriteUpgrade");
      assertEquals(writes[index].data, {
        ...row,
        observedAt: summary.observedAt,
      });
    }
  }
});

Deno.test("restart posts without a body and saves each outcome and summary", async () => {
  const context = testContext(globalArgs);
  const { result, calls } = await withMockedFetch((request) => {
    if (request.method === "GET") {
      return response({
        ...emptyPageBase,
        sprites: [rolloutSprite(1), rolloutSprite(2)],
      });
    }
    assertEquals(request.body, null);
    return new Response(null, { status: 204 });
  }, () => model.methods.restart.execute({ select: { all: true } }, context));
  assertEquals(calls.map((call) => call.method), ["GET", "POST", "POST"]);
  assertEquals(calls.slice(1).map((call) => new URL(call.url).pathname), [
    "/v1/sprites/worker-1/restart",
    "/v1/sprites/worker-2/restart",
  ]);
  assertEquals(result.dataHandles.map((handle) => handle.name), [
    "restart-sprite-1",
    "restart-sprite-2",
    "restart",
  ]);
  const writes = context.getWrittenResources();
  const summary = model.resources.restart.schema.parse(writes[2].data);
  const results = [1, 2].map((index) => ({
    name: `worker-${index}`,
    id: `sprite-${index}`,
    status: "applied",
  }));
  assertEquals(writes[2].specName, "restart");
  assertEquals(writes.at(-1)!.data, summary);
  assertEquals(summary, {
    select: { all: true },
    matched: 2,
    applied: 2,
    failed: 0,
    results,
    observedAt: summary.observedAt,
  });
  for (const [index, row] of results.entries()) {
    assertEquals(writes[index].specName, "spriteRestart");
    assertEquals(writes[index].data, {
      ...row,
      observedAt: summary.observedAt,
    });
  }
});

function progress(...events: unknown[]): Response {
  return new Response(
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    {
      headers: { "content-type": "application/x-ndjson" },
    },
  );
}

Deno.test("createCheckpoint saves the newest checkpoint and continues after an empty list", async () => {
  for (const empty of [false, true]) {
    const context = testContext(globalArgs);
    const newest = {
      id: "new",
      create_time: "2026-09-11T12:00:00Z",
      comment: "release",
    };
    const bodies: unknown[] = [];
    const { result, calls } = await withMockedFetch(
      async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/sprites") {
          return response({
            ...emptyPageBase,
            sprites: [1, 2, 3].map((i) => rolloutSprite(i)),
          });
        }
        if (request.method === "POST") {
          bodies.push(await request.json());
          return progress({
            type: "complete",
            data: "done",
            time: newest.create_time,
          });
        }
        assertEquals(request.body, null);
        return response(
          empty && path.includes("worker-2") ? [] : [
            newest,
            { id: "old", create_time: "2026-09-11T13:00:00+02:00" },
          ],
        );
      },
      () =>
        model.methods.createCheckpoint.execute({
          select: { all: true },
          comment: "release",
        }, context),
    );
    assertEquals(
      calls.map((call) => [call.method, new URL(call.url).pathname]),
      [
        ["GET", "/v1/sprites"],
        ...[1, 2, 3].flatMap((i) => [
          ["POST", `/v1/sprites/worker-${i}/checkpoint`],
          ["GET", `/v1/sprites/worker-${i}/checkpoints`],
        ]),
      ],
    );
    assertEquals(bodies, [1, 2, 3].map(() => ({ comment: "release" })));
    const writes = context.getWrittenResources();
    const summary = model.resources.createCheckpoint.schema.parse(
      writes[3].data,
    );
    const results = [1, 2, 3].map((i) => ({
      name: `worker-${i}`,
      id: `sprite-${i}`,
      ...(empty && i === 2
        ? { status: "failed", error: "request failed" }
        : { status: "applied", checkpoint: newest }),
    }));
    assertEquals(writes[3].specName, "createCheckpoint");
    assertEquals(writes[3].name, "createCheckpoint");
    assertEquals(summary, {
      select: { all: true },
      matched: 3,
      applied: empty ? 2 : 3,
      failed: empty ? 1 : 0,
      results,
      observedAt: summary.observedAt,
    });
    assertEquals(result.dataHandles.map((h) => h.name), [
      "createCheckpoint-sprite-1",
      "createCheckpoint-sprite-2",
      "createCheckpoint-sprite-3",
      "createCheckpoint",
    ]);
    for (const [i, row] of results.entries()) {
      assertEquals(writes[i].specName, "spriteCreateCheckpoint");
      assertEquals(writes[i].name, `createCheckpoint-sprite-${i + 1}`);
      assertEquals(writes[i].data, { ...row, observedAt: summary.observedAt });
    }
  }
});

const serviceDefinition = {
  cmd: "server",
  args: ["--serve"],
  env: { MODE: "test" },
  dir: "/app",
  needs: ["db"],
  http_port: 8080,
};
const savedService = { name: "web/api", ...serviceDefinition };

for (const action of ["put", "start", "stop", "restart", "delete"] as const) {
  Deno.test(`${action}Service routes requests and saves each outcome and the rollout`, async () => {
    const context = testContext(globalArgs);
    const bodies: string[] = [];
    const { result, calls } = await withMockedFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/sprites") {
        return response({
          ...emptyPageBase,
          sprites: [1, 2].map((i) => rolloutSprite(i)),
        });
      }
      if (request.method === "GET") return response(savedService);
      bodies.push(await request.text());
      if (action === "delete") {
        return new Response(null, {
          status: url.pathname.includes("worker-2") ? 404 : 204,
        });
      }
      return progress(
        action === "stop"
          ? {
            type: url.pathname.includes("worker-2") ? "exit" : "stopped",
            exit_code: 9,
            timestamp: 1,
          }
          : { type: "started", timestamp: 1 },
        { type: "complete", timestamp: 2 },
      );
    }, () => {
      const args = { select: { all: true as const }, service_name: "web/api" };
      switch (action) {
        case "put":
          return model.methods.putService.execute({
            ...args,
            service: serviceDefinition,
            duration: "2s",
          }, context);
        case "start":
          return model.methods.startService.execute(
            { ...args, duration: "2s" },
            context,
          );
        case "restart":
          return model.methods.restartService.execute({
            ...args,
            duration: "2s",
          }, context);
        case "stop":
          return model.methods.stopService.execute(
            { ...args, timeout: "2s" },
            context,
          );
        case "delete":
          return model.methods.deleteService.execute(args, context);
      }
    });
    const startup = action === "put" || action === "start" ||
      action === "restart";
    assertEquals(
      calls.slice(1).map((
        call,
      ) => [call.method, new URL(call.url).pathname, new URL(call.url).search]),
      [1, 2].flatMap((i) => {
        const path = `/v1/sprites/worker-${i}/services/web%2Fapi`;
        return [
          [
            action === "put" ? "PUT" : action === "delete" ? "DELETE" : "POST",
            path +
            (action === "put" || action === "delete" ? "" : `/${action}`),
            action === "delete"
              ? ""
              : action === "stop"
              ? "?timeout=2s"
              : "?duration=2s",
          ],
          ...(startup ? [["GET", path, ""]] : []),
        ];
      }),
    );
    assertEquals(
      bodies,
      [1, 2].map(() =>
        action === "put" ? JSON.stringify(serviceDefinition) : ""
      ),
    );
    const writes = context.getWrittenResources();
    const methodName = `${action}Service` as const;
    const rowSpec = `sprite${action[0].toUpperCase()}${action.slice(1)}Service`;
    const summary = model.resources[methodName].schema.parse(writes[2].data);
    const results = [1, 2].map((i) => ({
      name: `worker-${i}`,
      id: `sprite-${i}`,
      serviceName: "web/api",
      status: "applied",
      ...(action === "delete"
        ? {}
        : { exitCode: action === "stop" ? 9 : null }),
      ...(action === "put" ? { service: savedService } : {}),
    }));
    assertEquals(writes[2].specName, methodName);
    assertEquals(writes[2].name, methodName);
    assertEquals(summary, {
      select: { all: true },
      matched: 2,
      applied: 2,
      failed: 0,
      results,
      observedAt: summary.observedAt,
    });
    assertEquals(result.dataHandles.map((h) => h.name), [
      `${methodName}-sprite-1`,
      `${methodName}-sprite-2`,
      methodName,
    ]);
    for (const [i, row] of results.entries()) {
      assertEquals(writes[i].specName, rowSpec);
      assertEquals(writes[i].name, `${methodName}-sprite-${i + 1}`);
      assertEquals(writes[i].data, { ...row, observedAt: summary.observedAt });
    }
  });
}

Deno.test("putService names cannot collide across service and Sprite name boundaries", async () => {
  const context = testContext(globalArgs);
  await withMockedFetch(
    [
      response({
        ...emptyPageBase,
        sprites: [{ ...rolloutSprite(1), id: "sprite-id-1", name: "b-c" }],
      }),
      progress({ type: "complete", timestamp: 1 }),
      response({ ...savedService, name: "a" }),
    ],
    () =>
      model.methods.putService.execute({
        select: { all: true },
        service_name: "a",
        service: { cmd: "server", args: [], needs: [] },
      }, context),
  );
  await withMockedFetch(
    [
      response({
        ...emptyPageBase,
        sprites: [{ ...rolloutSprite(2), id: "sprite-id-2", name: "c" }],
      }),
      response({ error: "private provider output" }, 500),
    ],
    () =>
      model.methods.putService.execute({
        select: { all: true },
        service_name: "a-b",
        service: { cmd: "server", args: [], needs: [] },
      }, context),
  );

  const writes = context.getWrittenResources();
  assertEquals([writes[0].name, writes[2].name], [
    "putService-sprite-id-1",
    "putService-sprite-id-2",
  ]);
  assertEquals(writes[0].data.serviceName, "a");
  assertEquals(writes[2].data, {
    name: "c",
    id: "sprite-id-2",
    serviceName: "a-b",
    status: "failed",
    error: "HTTP 500",
    observedAt: writes[2].data.observedAt,
  });
  assertEquals(writes[3].data.results, [{
    name: "c",
    id: "sprite-id-2",
    serviceName: "a-b",
    status: "failed",
    error: "HTTP 500",
  }]);
});

Deno.test("putService records a startup exit and still runs the third Sprite", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch(
    [
      response({
        ...emptyPageBase,
        sprites: [1, 2, 3].map((i) => rolloutSprite(i)),
      }),
      progress({ type: "complete", timestamp: 1 }),
      response(savedService),
      progress({ type: "exit", exit_code: 17, timestamp: 1 }, {
        type: "complete",
        timestamp: 2,
      }),
      progress({ type: "complete", timestamp: 1 }),
      response(savedService),
    ],
    () =>
      model.methods.putService.execute({
        select: { all: true },
        service_name: "web",
        service: { cmd: "server", args: [], needs: [] },
      }, context),
  );
  assertEquals(calls.map((call) => call.method), [
    "GET",
    "PUT",
    "GET",
    "PUT",
    "PUT",
    "GET",
  ]);
  assertEquals(
    new URL(calls[4].url).pathname,
    "/v1/sprites/worker-3/services/web",
  );
  const writes = context.getWrittenResources();
  const summary = model.resources.putService.schema.parse(writes[3].data);
  assertEquals([summary.matched, summary.applied, summary.failed], [3, 2, 1]);
  const failed = {
    name: "worker-2",
    id: "sprite-2",
    serviceName: "web",
    status: "failed",
    error: "exited during startup with code 17",
    exitCode: 17,
    service: null,
  };
  assertEquals(summary.results[1], failed);
  assertEquals(writes[1].specName, "spritePutService");
  assertEquals(writes[1].name, "putService-sprite-2");
  assertEquals(writes[1].data, { ...failed, observedAt: summary.observedAt });
  assertEquals(summary.results[2].status, "applied");
});

Deno.test("exec records nonzero exits, continues after transport failure, and saves output before the summary", async () => {
  const context = testContext({ ...globalArgs, timeoutMs: 90_000 });
  const order: string[] = [];
  const files: { spec: string; name: string; bytes: Uint8Array }[] = [];
  const createFileWriter = context.createFileWriter.bind(context);
  context.createFileWriter = (spec, name) => ({
    writeAll: async (bytes) => {
      files.push({ spec, name, bytes });
      return await createFileWriter(spec, name).writeAll(bytes);
    },
  });
  const execute: ManagementExec = (ctx, name, query, input) => {
    assertEquals(ctx, context);
    assertEquals(ctx.globalArgs.timeoutMs, 90_000);
    assertEquals(context.getWrittenResources().length, order.length);
    order.push(name);
    assertEquals(query, {
      cmd: ["cat"],
      path: "/bin/cat",
      dir: "/tmp",
      env: ["MODE=test"],
      stdin: true,
    });
    assertEquals(input, new TextEncoder().encode("hello"));
    if (name === "worker-3") {
      return Promise.reject(new Error("private transport details"));
    }
    return Promise.resolve({
      stdout: new Uint8Array([0, 255]),
      stderr: new Uint8Array([10]),
      exitCode: name === "worker-2" ? 1 : 0,
    });
  };
  Object.assign(context, { managementExec: execute });
  const { result } = await withMockedFetch(
    [
      response({
        ...emptyPageBase,
        sprites: [1, 2, 3].map((i) => rolloutSprite(i)),
      }),
    ],
    () =>
      model.methods.exec.execute(
        {
          select: { all: true },
          cmd: ["cat"],
          path: "/bin/cat",
          dir: "/tmp",
          env: { MODE: "test" },
          input: { kind: "text", text: "hello" },
        },
        context,
      ),
  );
  assertEquals(order, ["worker-1", "worker-2", "worker-3"]);
  const writes = context.getWrittenResources();
  const summary = model.resources.exec.schema.parse(writes[3].data);
  const rows = [
    {
      name: "worker-1",
      id: "sprite-1",
      status: "applied",
      exitCode: 0,
      stdoutBytes: 2,
      stderrBytes: 1,
    },
    {
      name: "worker-2",
      id: "sprite-2",
      status: "applied",
      exitCode: 1,
      stdoutBytes: 2,
      stderrBytes: 1,
    },
    {
      name: "worker-3",
      id: "sprite-3",
      status: "failed",
      error: "request failed",
    },
  ];
  assertEquals(summary, {
    select: { all: true },
    matched: 3,
    applied: 2,
    failed: 1,
    nonzero: 1,
    results: rows,
    observedAt: summary.observedAt,
  });
  assertEquals(writes.map((w) => [w.specName, w.name]), [
    ["spriteExec", "exec-sprite-1"],
    ["spriteExec", "exec-sprite-2"],
    ["spriteExec", "exec-sprite-3"],
    ["exec", "exec"],
  ]);
  assertEquals(
    writes.slice(0, 3).map((w) => w.data),
    rows.map((row) => ({ ...row, observedAt: summary.observedAt })),
  );
  assertEquals(
    files,
    [1, 2].flatMap((i) => [
      {
        spec: "spriteExecStdout",
        name: `execStdout-sprite-${i}`,
        bytes: new Uint8Array([0, 255]),
      },
      {
        spec: "spriteExecStderr",
        name: `execStderr-sprite-${i}`,
        bytes: new Uint8Array([10]),
      },
    ]),
  );
  assertEquals(result.dataHandles.map((h) => h.name), [
    "execStdout-sprite-1",
    "execStderr-sprite-1",
    "exec-sprite-1",
    "execStdout-sprite-2",
    "execStderr-sprite-2",
    "exec-sprite-2",
    "exec-sprite-3",
    "exec",
  ]);
});
