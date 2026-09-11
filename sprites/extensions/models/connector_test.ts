// SPDX-License-Identifier: MIT

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.14";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { testContext } from "./_lib/test_support.ts";
import { AccessPolicySchema } from "./_lib/connectors.ts";
import { model } from "./connector.ts";

const globalArgs = {
  name: "connection-slot",
  provider: "slack",
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

Deno.test("access-policy method fields retain the published object description", () => {
  for (const name of ["createApiKey", "callback", "updatePolicy"] as const) {
    const field = model.methods[name].arguments.shape.access_policy;
    const schema = "unwrap" in field ? field.unwrap() : field;
    assertEquals(schema.description, AccessPolicySchema.description, name);
  }
});

Deno.test("method logs use the public description for start and finish", async () => {
  const context = testContext({ ...globalArgs, provider: "openrouter" });
  const logs: Array<[string, ...unknown[]]> = [];
  context.logger.info = (message, ...properties) => {
    logs.push([message, ...properties]);
  };
  await withMockedFetch(
    [jsonResponse({
      connection: connection({
        provider: "openrouter",
        connection_type: "provisioned",
        scopes: null,
        user_id: null,
      }),
    }, 201)],
    () => model.methods.provision.execute({}, context),
  );
  const operation = model.methods.provision.description;
  assertEquals(logs, [
    ["Starting {operation}", { operation }],
    ["Finished {operation}", { operation }],
  ]);
});

Deno.test("createApiKey sends snake_case credential and policy fields once", async () => {
  const context = testContext({ ...globalArgs, provider: "custom_api" });
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
  assertEquals(getWrittenResources()[0].specName, "state");
});

Deno.test("provision sends only the provider and stores its connection", async () => {
  const context = testContext({ ...globalArgs, provider: "openrouter" });
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
        {},
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
    getWrittenResources()[0].data,
    connection({
      provider: "openrouter",
      connection_type: "provisioned",
      scopes: null,
      user_id: null,
    }),
  );
  assertEquals(getWrittenResources().length, 1);
});

Deno.test("get encodes the saved organization-scoped connector id", async () => {
  const context = testContext(globalArgs, {
    storedResources: { state: connection({ id: "connection/one" }) },
  });

  const { calls } = await withMockedFetch(
    [jsonResponse({ connection: connection({ id: "connection/one" }) })],
    () =>
      model.methods.get.execute(
        {},
        context,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET");
  assertStringIncludes(calls[0].url, "/v1/oauth/connections/connection%2Fone");
  assertEquals(
    context.getWrittenResources()[0].data,
    connection({ id: "connection/one" }),
  );
});

Deno.test("updatePolicy sends the complete replacement policy", async () => {
  const context = testContext(globalArgs, {
    storedResources: { state: connection() },
  });
  let requestBody: unknown;

  const { calls } = await withMockedFetch(
    async (request) => {
      requestBody = await request.json();
      return jsonResponse({ connection: connection() });
    },
    () =>
      model.methods.updatePolicy.execute(
        { access_policy: policy },
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
  assertEquals(context.getWrittenResources().length, 1);
});

Deno.test("delete sends one DELETE and clears the saved id", async () => {
  const context = testContext(globalArgs, {
    storedResources: { state: connection() },
  });

  const { result, calls } = await withMockedFetch(
    [new Response(null, { status: 204 })],
    () =>
      model.methods.delete.execute(
        {},
        context,
      ),
  );

  assertEquals(calls.map((call) => call.method), ["DELETE"]);
  assertEquals(result.dataHandles.length, 0);
  const writes = context.getWrittenResources();
  assertEquals(writes.length, 0);
  assertEquals(context.getDeletedResources(), ["state"]);
});

Deno.test("delete accepts a 404 as an already-completed deletion", async () => {
  const context = testContext(globalArgs, {
    storedResources: { state: connection() },
  });

  const { calls } = await withMockedFetch(
    [jsonResponse({ error: "not found" }, 404)],
    () =>
      model.methods.delete.execute(
        {},
        context,
      ),
  );

  assertEquals(calls.map((call) => call.method), ["DELETE"]);
  assertEquals(context.getWrittenResources(), []);
  assertEquals(context.getDeletedResources(), ["state"]);
});

Deno.test("authorize sends OAuth query fields and stores sensitive output", async () => {
  const context = testContext({ ...globalArgs, provider: "github" });

  const { calls } = await withMockedFetch(
    [jsonResponse({
      authorize_url:
        "https://github.com/login/oauth/authorize?client_id=client",
      state: "server-state",
    })],
    () =>
      model.methods.authorize.execute(
        {
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
  assertEquals(context.getWrittenResources()[0].specName, "authorize");
});

Deno.test("callback sends code and saved state and policy without the provider path field", async () => {
  const context = testContext({ ...globalArgs, provider: "github" }, {
    storedResources: {
      authorize: {
        authorize_url: "https://example.com/authorize",
        state: "server-state",
      },
    },
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
          code: "oauth-code",
          redirect_uri: "https://client.example.test/oauth/callback",
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
  assertEquals(context.getWrittenResources()[0].specName, "state");
});

Deno.test("connector binding methods refuse an already saved connection id", async () => {
  for (
    const name of [
      "createApiKey",
      "provision",
      "authorize",
      "callback",
    ] as const
  ) {
    const context = testContext(globalArgs, {
      storedResources: {
        state: connection(),
        authorize: { authorize_url: "https://example.com", state: "s" },
      },
    });
    const { calls } = await withMockedFetch([], () =>
      assertRejects(
        () =>
          model.methods[name].execute(
            model.methods[name].arguments.parse({
              api_key: "secret",
              code: "secret",
            }) as never,
            context,
          ),
        Error,
        "already saved",
      ));
    assertEquals(calls.length, 0);
    assertEquals(context.getWrittenResources(), []);
    assertEquals(context.getDeletedResources(), []);
  }
});
Deno.test("connector non-binding methods require the saved connection identity", async () => {
  for (const name of ["get", "updatePolicy", "delete"] as const) {
    const context = testContext(globalArgs);
    const { calls } = await withMockedFetch([], () =>
      assertRejects(
        () =>
          model.methods[name].execute(
            model.methods[name].arguments.parse({
              access_policy: policy,
            }) as never,
            context,
          ),
        Error,
        "No connection identity is saved",
      ));
    assertEquals(calls.length, 0);
    assertEquals(context.getWrittenResources(), []);
  }
});
Deno.test("connector lookup binds a connection with secrets excluded", async () => {
  const context = testContext(globalArgs);
  const { calls } = await withMockedFetch([
    jsonResponse({
      connection: {
        ...connection({ id: "connection/one" }),
        api_key: "secret",
        access_token: "secret",
        refresh_token: "secret",
      },
    }),
  ], () => model.methods.lookup.execute({ id: "connection/one" }, context));
  assertEquals(
    calls[0].url,
    "https://api.sprites.dev/v1/oauth/connections/connection%2Fone",
  );
  assertEquals(
    context.getWrittenResources()[0].data,
    connection({ id: "connection/one" }),
  );
});
Deno.test("connector callback requires pending authorization and clears it only on success", async () => {
  const context = testContext(globalArgs);
  await withMockedFetch(
    [],
    () =>
      assertRejects(
        () => model.methods.callback.execute({ code: "secret" }, context),
        Error,
        "No pending OAuth",
      ),
  );
  for (const success of [false, true]) {
    const pending = {
      authorize_url: "https://example.com/authorize",
      state: "saved-secret",
    };
    const test = testContext(globalArgs, {
      storedResources: { authorize: pending },
    });
    let body: unknown;
    await withMockedFetch(
      async (req) => {
        body = await req.json();
        return success
          ? jsonResponse({ connection: connection() })
          : jsonResponse({ error: "failed" }, 500);
      },
      (): Promise<unknown> =>
        success
          ? model.methods.callback.execute({ code: "code" }, test)
          : assertRejects(
            () => model.methods.callback.execute({ code: "code" }, test),
            Error,
          ),
    );
    assertEquals(body, { code: "code", state: "saved-secret" });
    assertEquals(test.getDeletedResources(), success ? ["authorize"] : []);
    assertEquals(test.getWrittenResources().length, success ? 1 : 0);
  }
  assertEquals(model.resources.authorize.schema.meta()?.sensitive, true);
});
