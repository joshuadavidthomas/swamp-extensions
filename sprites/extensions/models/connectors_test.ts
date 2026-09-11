// SPDX-License-Identifier: MIT

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  createModelTestContext as createBaseModelTestContext,
  withMockedFetch,
} from "@swamp-club/swamp-testing";
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

function createModelTestContext(
  options: Parameters<typeof createBaseModelTestContext>[0],
) {
  const result = createBaseModelTestContext(options);
  return {
    ...result,
    context: {
      ...result.context,
      deleteResource: async (_name: string): Promise<void> => {},
    },
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "connection-1",
    provider: "slack",
    provider_account_id: "team-1",
    provider_account_name: "Acme",
    scopes: "chat:write,channels:read",
    connection_type: "oauth",
    access_policy: policy,
    provider_info: {
      icon: "speech-bubble",
      nested: { color: "aubergine", flags: [true, null, 3] },
    },
    user_id: "user-1",
    token_expires_at: "2026-09-10T12:00:00Z",
    inserted_at: "2026-09-09T10:00:00Z",
    updated_at: "2026-09-09T11:00:00Z",
    usage_snippet: "fetch('/v1/gateway/slack/connection-1/...')",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("connections can have no token expiry", async () => {
  const test = createModelTestContext({ globalArgs });
  const value = connection({ token_expires_at: null });
  await withMockedFetch(
    [jsonResponse({ connections: [value] })],
    () => model.methods.list.execute({}, { ...test.context, globalArgs }),
  );
  assertEquals(test.getWrittenResources()[0].data, {
    connections: [value],
    truncated: false,
  });
});

Deno.test("list routes provider filtering and retains open provider_info metadata", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "list",
  });

  const { result, calls } = await withMockedFetch(
    [jsonResponse({ connections: [connection()] })],
    () =>
      model.methods.list.execute(
        { provider: "slack" },
        { ...context, globalArgs },
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
  assertEquals(writes[0].name, "connections");
  assertEquals(writes[0].data, {
    connections: [connection()],
    truncated: false,
  });
});

Deno.test("list omits the optional provider query field", async () => {
  const { context } = createModelTestContext({
    globalArgs,
    methodName: "list",
  });

  const { calls } = await withMockedFetch(
    [jsonResponse({ connections: [] })],
    () => model.methods.list.execute({}, { ...context, globalArgs }),
  );

  assertEquals(new URL(calls[0].url).search, "");
});

Deno.test("createApiKey sends snake_case credential and policy fields once", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "createApiKey",
  });
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
        { ...context, globalArgs },
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
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "provision",
  });
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
        { ...context, globalArgs },
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
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "get",
  });

  const { calls } = await withMockedFetch(
    [jsonResponse({ connection: connection({ id: "connection/one" }) })],
    () =>
      model.methods.get.execute(
        { id: "connection/one" },
        { ...context, globalArgs },
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assertStringIncludes(calls[0].url, "/v1/oauth/connections/connection%2Fone");
  assertEquals(getWrittenResources()[0].data, {
    connection: connection({ id: "connection/one" }),
  });
});

for (
  const [methodName, verb] of [
    ["patchPolicy", "PATCH"],
    ["updatePolicy", "PUT"],
  ] as const
) {
  Deno.test(`${methodName} sends the same complete replacement policy`, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName,
    });
    let requestBody: unknown;

    const { calls } = await withMockedFetch(
      async (request) => {
        requestBody = await request.json();
        return jsonResponse({ connection: connection() });
      },
      () =>
        model.methods[methodName].execute(
          { id: "connection-1", access_policy: policy },
          { ...context, globalArgs },
        ),
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, verb);
    assertEquals(
      new URL(calls[0].url).pathname,
      "/v1/oauth/connections/connection-1",
    );
    assertEquals(requestBody, { access_policy: policy });
    assertEquals(getWrittenResources().length, 1);
  });
}

Deno.test("delete verifies the returned id before issuing DELETE", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "delete",
  });

  const { result, calls } = await withMockedFetch(
    (request) => {
      if (request.method === "GET") {
        return jsonResponse({ connection: connection() });
      }
      return new Response(null, { status: 204 });
    },
    () =>
      model.methods.delete.execute(
        { id: "connection-1" },
        { ...context, globalArgs },
      ),
  );

  assertEquals(calls.map((call) => call.method), ["GET", "DELETE"]);
  assertEquals(result.dataHandles.length, 1);
  const writes = getWrittenResources();
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "deletion");
  assertEquals(writes[0].name, "deletion");
  assertEquals(writes[0].data, { completed: true, id: "connection-1" });
});

Deno.test("delete accepts a 404 from DELETE after a successful preflight", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "delete",
  });

  const { calls } = await withMockedFetch(
    (request) =>
      request.method === "GET"
        ? jsonResponse({ connection: connection() })
        : jsonResponse({ error: "not found" }, 404),
    () =>
      model.methods.delete.execute(
        { id: "connection-1" },
        { ...context, globalArgs },
      ),
  );

  assertEquals(calls.map((call) => call.method), ["GET", "DELETE"]);
  assertEquals(getWrittenResources()[0].data, {
    completed: true,
    id: "connection-1",
  });
});

Deno.test("delete treats a 404 preflight as an already-completed deletion", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "delete",
  });

  const { calls } = await withMockedFetch(
    [jsonResponse({ error: "not found" }, 404)],
    () =>
      model.methods.delete.execute(
        { id: "connection-1" },
        { ...context, globalArgs },
      ),
  );

  assertEquals(calls.map((call) => call.method), ["GET"]);
  assertEquals(getWrittenResources()[0].data, {
    completed: true,
    id: "connection-1",
  });
});

Deno.test("delete stops without a write when preflight returns another id", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "delete",
  });
  let requestCount = 0;

  const error = await assertRejects(
    () =>
      withMockedFetch(
        (request) => {
          requestCount += 1;
          assertEquals(request.method, "GET");
          return jsonResponse({
            connection: connection({ id: "connection-other" }),
          });
        },
        () =>
          model.methods.delete.execute(
            { id: "connection-1" },
            { ...context, globalArgs },
          ),
      ),
    Error,
  );

  assertStringIncludes(error.message, "different connector id");
  assertEquals(requestCount, 1);
  assertEquals(getWrittenResources(), []);
});

Deno.test("authorize sends OAuth query fields and stores sensitive output", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "authorize",
  });

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
        { ...context, globalArgs },
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
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "callback",
  });
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
        { ...context, globalArgs },
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

Deno.test("credential and authorization schemas mark secrets as sensitive", () => {
  assertEquals(
    model.globalArguments.shape.token.meta()?.sensitive,
    true,
  );
  assertEquals(
    model.methods.createApiKey.arguments.shape.api_key.meta()?.sensitive,
    true,
  );
  assertEquals(
    model.methods.callback.arguments.shape.code.meta()?.sensitive,
    true,
  );
  assertEquals(
    model.resources.authorization.schema.shape.authorize_url.meta()?.sensitive,
    true,
  );
  assertEquals(
    model.resources.authorization.schema.shape.state.meta()?.sensitive,
    true,
  );
});

for (const methodName of ["createApiKey", "provision", "callback"] as const) {
  Deno.test(`${methodName} does not retry failures or write output`, async () => {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      methodName,
    });
    let requests = 0;
    const execute = methodName === "createApiKey"
      ? () =>
        model.methods.createApiKey.execute(
          { provider: "custom_api", api_key: "secret" },
          { ...context, globalArgs },
        )
      : methodName === "provision"
      ? () =>
        model.methods.provision.execute(
          { provider: "slack" },
          { ...context, globalArgs },
        )
      : () =>
        model.methods.callback.execute(
          { provider: "github", code: "oauth-code" },
          { ...context, globalArgs },
        );

    await assertRejects(
      () =>
        withMockedFetch(
          () => {
            requests += 1;
            return jsonResponse({ error: "upstream failure" }, 503);
          },
          execute,
        ),
      Error,
    );

    assertEquals(requests, 1);
    assertEquals(getWrittenResources(), []);
  });
}

Deno.test("invalid API output fails without writing a resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    methodName: "list",
  });

  const error = await assertRejects(
    () =>
      withMockedFetch(
        [jsonResponse({ connections: [{ id: "incomplete" }] })],
        () => model.methods.list.execute({}, { ...context, globalArgs }),
      ),
    Error,
  );

  assertStringIncludes(error.message, "invalid JSON response");
  assertEquals(getWrittenResources(), []);
});

Deno.test("HTTPS transport validation runs before connector mutations", async () => {
  const insecureArgs = { ...globalArgs, baseUrl: "http://api.sprites.dev" };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: insecureArgs,
    methodName: "createApiKey",
  });
  let requests = 0;

  await assertRejects(
    () =>
      withMockedFetch(
        () => {
          requests += 1;
          return jsonResponse({ connection: connection() }, 201);
        },
        () =>
          model.methods.createApiKey.execute(
            { provider: "custom_api", api_key: "secret" },
            { ...context, globalArgs: insecureArgs },
          ),
      ),
    Error,
  );

  assertEquals(requests, 0);
  assertEquals(getWrittenResources(), []);
});
