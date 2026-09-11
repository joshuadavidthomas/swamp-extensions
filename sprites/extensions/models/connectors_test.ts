// SPDX-License-Identifier: MIT

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { testContext } from "./_lib/test_support.ts";
import { model } from "./connectors.ts";

const globalArgs = {
  token: "test-organization-token",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
};

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
  });
}

Deno.test("list routes provider filtering and retains open provider_info metadata", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  const { result, calls } = await withMockedFetch(
    [jsonResponse({ connections: [connection()] })],
    () =>
      model.methods.list.execute(
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
    "Bearer test-organization-token",
  );
  assertEquals(result.dataHandles.length, 1);
  const writes = getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "connections");
  assertEquals(writes[0].data, {
    connections: [connection()],
  });
});

Deno.test("list omits the optional provider query field", async () => {
  const context = testContext(globalArgs);

  const { calls } = await withMockedFetch(
    [jsonResponse({ connections: [] })],
    () => model.methods.list.execute({}, context),
  );

  assertEquals(new URL(calls[0].url).search, "");
});

Deno.test("createApiKey sends snake_case credential and policy fields once", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;
  let requestBody: unknown;

  const { calls } = await withMockedFetch(
    async (request) => {
      requestBody = await request.json();
      return jsonResponse({
        connection: connection({
          provider: "custom_api",
          connection_type: "api_key",
        }),
      }, 201);
    },
    () =>
      model.methods.createApiKey.execute(
        {
          provider: "custom_api",
          api_key: "provider-secret",
          access_policy: policy,
        },
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(new URL(calls[0].url).pathname, "/v1/oauth/connections/api_key");
  assertEquals(requestBody, {
    provider: "custom_api",
    api_key: "provider-secret",
    access_policy: policy,
  });
  assertEquals(getWrittenResources().length, 1);
  assertEquals(getWrittenResources()[0].specName, "connection");
});

Deno.test("provision sends only the provider and stores its connection", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;
  let requestBody: unknown;

  const { calls } = await withMockedFetch(
    async (request) => {
      requestBody = await request.json();
      return jsonResponse({
        connection: connection({
          provider: "openrouter",
          connection_type: "provisioned",
          scopes: null,
          user_id: null,
        }),
      }, 201);
    },
    () =>
      model.methods.provision.execute(
        { provider: "openrouter" },
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(
    new URL(calls[0].url).pathname,
    "/v1/oauth/connections/provision",
  );
  assertEquals(requestBody, { provider: "openrouter" });
  assertEquals(
    getWrittenResources()[0].data.connection,
    connection({
      provider: "openrouter",
      connection_type: "provisioned",
      scopes: null,
      user_id: null,
    }),
  );
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("get encodes the organization-scoped connector id", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  const { calls } = await withMockedFetch(
    [jsonResponse({ connection: connection({ id: "connection/one" }) })],
    () =>
      model.methods.get.execute(
        { id: "connection/one" },
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assertStringIncludes(calls[0].url, "/v1/oauth/connections/connection%2Fone");
  assertEquals(getWrittenResources()[0].data, {
    connection: connection({ id: "connection/one" }),
  });
});

Deno.test("updatePolicy sends the complete replacement policy", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;
  let requestBody: unknown;

  const { calls } = await withMockedFetch(
    async (request) => {
      requestBody = await request.json();
      return jsonResponse({ connection: connection() });
    },
    () =>
      model.methods.updatePolicy.execute(
        { id: "connection-1", access_policy: policy },
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "PUT");
  assertEquals(
    new URL(calls[0].url).pathname,
    "/v1/oauth/connections/connection-1",
  );
  assertEquals(requestBody, { access_policy: policy });
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("delete sends one DELETE and stores the id", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  const { result, calls } = await withMockedFetch(
    [new Response(null, { status: 204 })],
    () =>
      model.methods.delete.execute(
        { id: "connection-1" },
        context,
      ),
  );

  assertEquals(calls.map((call) => call.method), ["DELETE"]);
  assertEquals(result.dataHandles.length, 1);
  const writes = getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "deletion");
  assertEquals(writes[0].data, { id: "connection-1" });
});

Deno.test("delete accepts a 404 as an already-completed deletion", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  const { calls } = await withMockedFetch(
    [jsonResponse({ error: "not found" }, 404)],
    () =>
      model.methods.delete.execute(
        { id: "connection-1" },
        context,
      ),
  );

  assertEquals(calls.map((call) => call.method), ["DELETE"]);
  assertEquals(getWrittenResources()[0].data, {
    id: "connection-1",
  });
});

Deno.test("authorize sends OAuth query fields and stores sensitive output", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  const { calls } = await withMockedFetch(
    [jsonResponse({
      authorize_url:
        "https://github.com/login/oauth/authorize?client_id=client",
      state: "server-state",
    })],
    () =>
      model.methods.authorize.execute(
        {
          provider: "github",
          scopes: "repo,user",
          add_scopes: "workflow",
          redirect_uri: "https://client.example.test/oauth/callback",
          state: "client-state",
        },
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/v1/oauth/github/authorize");
  assertEquals(url.searchParams.get("scopes"), "repo,user");
  assertEquals(url.searchParams.get("add_scopes"), "workflow");
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "https://client.example.test/oauth/callback",
  );
  assertEquals(url.searchParams.get("state"), "client-state");
  assertEquals(getWrittenResources()[0].specName, "authorization");
});

Deno.test("callback sends code and policy without the provider path field", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;
  let requestBody: unknown;

  const { calls } = await withMockedFetch(
    async (request) => {
      requestBody = await request.json();
      return jsonResponse(
        { connection: connection({ provider: "github" }) },
        201,
      );
    },
    () =>
      model.methods.callback.execute(
        {
          provider: "github",
          code: "oauth-code",
          redirect_uri: "https://client.example.test/oauth/callback",
          state: "server-state",
          access_policy: policy,
        },
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "POST");
  assertEquals(new URL(calls[0].url).pathname, "/v1/oauth/github/callback");
  assertEquals(requestBody, {
    code: "oauth-code",
    redirect_uri: "https://client.example.test/oauth/callback",
    state: "server-state",
    access_policy: policy,
  });
  assertEquals(getWrittenResources()[0].specName, "connection");
});

Deno.test("invalid API output fails without writing a resource", async () => {
  const context = testContext(globalArgs);
  const { getWrittenResources } = context;

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [jsonResponse({ connections: [{ id: "incomplete" }] })],
        () => model.methods.list.execute({}, context),
      ),
    Error,
  );

  assertStringIncludes(error.message, "invalid JSON response");
  assertEquals(getWrittenResources(), []);
});
