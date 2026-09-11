// SPDX-License-Identifier: MIT
/** Organization-scoped connector and OAuth operations for the Sprites API. @module */

import { z } from "zod";
import {
  Acknowledgement,
  ApiError,
  AuthSchema,
  type Context,
  emptyRequest,
  jsonRequest,
  method,
  resource,
  segment,
} from "./_lib/core.ts";

const AccessPolicySchema = z.object({
  allow_all: z.boolean().optional().describe(
    "Grant every Sprite access; this overrides sprite_labels and name_prefix.",
  ),
  sprite_labels: z.array(z.string()).optional().describe(
    "Require every listed Sprite label.",
  ),
  name_prefix: z.string().optional().describe(
    "Require Sprite names to start with this prefix.",
  ),
  allowed_endpoints: z.array(z.string()).optional().describe(
    "Provider paths allowed by this replacement policy.",
  ),
  blocked_endpoints: z.array(z.string()).optional().describe(
    "Provider paths denied before allowed_endpoints are evaluated.",
  ),
}).describe(
  "Complete connector access policy. An empty policy denies every Sprite.",
);

const ConnectorProviderSchema = z.enum([
  "slack",
  "slack_bot",
  "github",
  "discourse",
  "openrouter",
  "ollama",
  "anthropic",
  "s3_object_store",
  "custom_api",
  "sprites_admin",
]);

const ConnectionTypeSchema = z.enum([
  "oauth",
  "api_key",
  "provisioned",
  "internal",
]);

const ConnectionSchema = z.object({
  id: z.string(),
  provider: ConnectorProviderSchema,
  provider_account_id: z.string(),
  provider_account_name: z.string().optional(),
  scopes: z.string().nullish(),
  connection_type: ConnectionTypeSchema.optional(),
  access_policy: AccessPolicySchema.optional(),
  provider_info: z.record(z.string(), z.json()).optional(),
  user_id: z.string().nullish(),
  token_expires_at: z.iso.datetime({ offset: true }).nullish(),
  inserted_at: z.iso.datetime({ offset: true }).optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
  usage_snippet: z.string().optional(),
});

const ConnectionResponseSchema = z.object({
  connection: ConnectionSchema,
});

const ApiConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionSchema),
});

const ConnectionsOutputSchema = ApiConnectionsResponseSchema.extend({
  truncated: z.literal(false),
});

const AuthorizationSchema = z.object({
  authorize_url: z.string().meta({ sensitive: true }),
  state: z.string().meta({ sensitive: true }),
});

const DeletionSchema = Acknowledgement.extend({
  id: z.string(),
});

const ProviderArgSchema = z.string().min(1).describe(
  "Connector provider sent as the provider API field.",
);

const IdArgSchema = z.string().min(1).describe(
  "Organization-scoped connector id sent as the id API path field.",
);

const ListArgsSchema = z.object({
  provider: z.string().optional().describe(
    "Optional provider API field used to filter connections.",
  ),
});

const CreateApiKeyArgsSchema = z.object({
  provider: ProviderArgSchema,
  api_key: z.string().min(1).meta({ sensitive: true }).describe(
    "Provider credential sent as the api_key API field; use a vault reference.",
  ),
  access_policy: AccessPolicySchema.optional().describe(
    "Optional replacement policy sent as the access_policy API field.",
  ),
});

const ProvisionArgsSchema = z.object({
  provider: ProviderArgSchema,
});

const IdArgsSchema = z.object({
  id: IdArgSchema,
});

const PolicyArgsSchema = z.object({
  id: IdArgSchema,
  access_policy: AccessPolicySchema.describe(
    "Complete replacement policy sent as the access_policy API field.",
  ),
});

const AuthorizeArgsSchema = z.object({
  provider: ProviderArgSchema,
  scopes: z.string().optional().describe(
    "Comma-separated scopes API field that replaces the provider defaults.",
  ),
  add_scopes: z.string().optional().describe(
    "Comma-separated add_scopes API field added to an existing grant.",
  ),
  redirect_uri: z.string().optional().describe(
    "OAuth redirect_uri API field.",
  ),
  state: z.string().optional().meta({ sensitive: true }).describe(
    "Optional OAuth state API field. Sprites generates one when omitted.",
  ),
});

const CallbackArgsSchema = z.object({
  provider: ProviderArgSchema,
  code: z.string().min(1).meta({ sensitive: true }).describe(
    "OAuth authorization code sent as the code API field.",
  ),
  redirect_uri: z.string().optional().describe(
    "OAuth redirect_uri API field.",
  ),
  state: z.string().optional().meta({ sensitive: true }).describe(
    "OAuth state API field returned by the authorization step.",
  ),
  access_policy: AccessPolicySchema.optional().describe(
    "Optional replacement policy sent as the access_policy API field.",
  ),
});

function validateTransport(ctx: Context): void {
  AuthSchema.parse(ctx.globalArgs);
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

async function replacePolicy(
  verb: "PATCH" | "PUT",
  args: z.output<typeof PolicyArgsSchema>,
  ctx: Context,
): Promise<z.input<typeof ConnectionResponseSchema>> {
  validateTransport(ctx);
  return await jsonRequest(
    ctx,
    verb,
    `/v1/oauth/connections/${segment(args.id)}`,
    ConnectionResponseSchema,
    { json: { access_policy: args.access_policy } },
  );
}

/** Complete organization-scoped Sprites connector collection model. */
export const model = {
  type: "@josh/sprites/connectors",
  version: "2026.09.09.1",
  globalArguments: AuthSchema,
  resources: {
    connection: resource(
      ConnectionResponseSchema,
      "One organization connector with its current access policy",
    ),
    connections: resource(
      ConnectionsOutputSchema,
      "Complete organization connector collection",
    ),
    authorization: resource(
      AuthorizationSchema,
      "Sensitive provider authorization URL and OAuth state",
      "1d",
    ),
    deletion: resource(
      DeletionSchema,
      "Acknowledgement of an idempotent connector deletion",
    ),
  },
  methods: {
    list: method(
      "List organization connectors",
      ListArgsSchema,
      "connections",
      ConnectionsOutputSchema,
      async (args, ctx) => {
        validateTransport(ctx);
        const result = await jsonRequest(
          ctx,
          "GET",
          "/v1/oauth/connections",
          ApiConnectionsResponseSchema,
          { query: { provider: args.provider } },
        );
        return { ...result, truncated: false as const };
      },
    ),
    createApiKey: method(
      "Create an API-key connector without automatic retries",
      CreateApiKeyArgsSchema,
      "connection",
      ConnectionResponseSchema,
      async (args, ctx) => {
        validateTransport(ctx);
        return await jsonRequest(
          ctx,
          "POST",
          "/v1/oauth/connections/api_key",
          ConnectionResponseSchema,
          { json: args },
        );
      },
    ),
    provision: method(
      "Provision a managed connector without automatic retries",
      ProvisionArgsSchema,
      "connection",
      ConnectionResponseSchema,
      async (args, ctx) => {
        validateTransport(ctx);
        return await jsonRequest(
          ctx,
          "POST",
          "/v1/oauth/connections/provision",
          ConnectionResponseSchema,
          { json: args },
        );
      },
    ),
    get: method(
      "Get an organization connector",
      IdArgsSchema,
      "connection",
      ConnectionResponseSchema,
      async (args, ctx) => {
        validateTransport(ctx);
        return await jsonRequest(
          ctx,
          "GET",
          `/v1/oauth/connections/${segment(args.id)}`,
          ConnectionResponseSchema,
        );
      },
    ),
    patchPolicy: method(
      "Replace a connector access policy with PATCH",
      PolicyArgsSchema,
      "connection",
      ConnectionResponseSchema,
      (args, ctx) => replacePolicy("PATCH", args, ctx),
    ),
    updatePolicy: method(
      "Replace a connector access policy with PUT",
      PolicyArgsSchema,
      "connection",
      ConnectionResponseSchema,
      (args, ctx) => replacePolicy("PUT", args, ctx),
    ),
    delete: method(
      "Delete a connector after verifying its organization-scoped id",
      IdArgsSchema,
      "deletion",
      DeletionSchema,
      async (args, ctx) => {
        validateTransport(ctx);
        const path = `/v1/oauth/connections/${segment(args.id)}`;
        let existing: z.output<typeof ConnectionResponseSchema>;
        try {
          existing = await jsonRequest(
            ctx,
            "GET",
            path,
            ConnectionResponseSchema,
          );
        } catch (error) {
          if (isNotFound(error)) {
            return { id: args.id, completed: true as const };
          }
          throw error;
        }

        if (existing.connection.id !== args.id) {
          throw new Error(
            "Sprites returned a different connector id during deletion preflight; no delete was sent.",
          );
        }

        try {
          await emptyRequest(ctx, "DELETE", path);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return { id: args.id, completed: true as const };
      },
    ),
    authorize: method(
      "Start provider OAuth authorization",
      AuthorizeArgsSchema,
      "authorization",
      AuthorizationSchema,
      async (args, ctx) => {
        validateTransport(ctx);
        const { provider, ...query } = args;
        return await jsonRequest(
          ctx,
          "GET",
          `/v1/oauth/${segment(provider)}/authorize`,
          AuthorizationSchema,
          { query },
        );
      },
    ),
    callback: method(
      "Complete provider OAuth authorization without automatic retries",
      CallbackArgsSchema,
      "connection",
      ConnectionResponseSchema,
      async (args, ctx) => {
        validateTransport(ctx);
        const { provider, ...json } = args;
        return await jsonRequest(
          ctx,
          "POST",
          `/v1/oauth/${segment(provider)}/callback`,
          ConnectionResponseSchema,
          { json },
        );
      },
    ),
  },
};
