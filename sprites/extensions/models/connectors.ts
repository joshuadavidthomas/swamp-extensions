// SPDX-License-Identifier: MIT
/** Organization-scoped connector and OAuth operations for the Sprites API. @module */

import { z } from "zod";
import {
  ApiError,
  AuthSchema,
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
  allowed_endpoints: z.array(z.string()).optional(),
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

const ConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionSchema),
});

const AuthorizationSchema = z.object({
  authorize_url: z.string().meta({ sensitive: true }),
  state: z.string().meta({ sensitive: true }),
});

const DeletionSchema = z.object({
  id: z.string(),
});

const ProviderArgSchema = z.string().min(1);

const IdArgSchema = z.string().min(1);

const ListArgsSchema = z.object({
  provider: z.string().optional(),
});

const CreateApiKeyArgsSchema = z.object({
  provider: ProviderArgSchema,
  api_key: z.string().min(1).meta({ sensitive: true }).describe(
    "Use a vault reference for the provider credential.",
  ),
  access_policy: AccessPolicySchema.optional(),
});

const ProvisionArgsSchema = z.object({
  provider: ProviderArgSchema,
});

const IdArgsSchema = z.object({
  id: IdArgSchema,
});

const PolicyArgsSchema = z.object({
  id: IdArgSchema,
  access_policy: AccessPolicySchema,
});

const AuthorizeArgsSchema = z.object({
  provider: ProviderArgSchema,
  scopes: z.string().optional().describe(
    "Comma-separated scopes API field that replaces the provider defaults.",
  ),
  add_scopes: z.string().optional().describe(
    "Comma-separated add_scopes API field added to an existing grant.",
  ),
  redirect_uri: z.string().optional(),
  state: z.string().optional().meta({ sensitive: true }).describe(
    "Optional OAuth state API field. Sprites generates one when omitted.",
  ),
});

const CallbackArgsSchema = z.object({
  provider: ProviderArgSchema,
  code: z.string().min(1).meta({ sensitive: true }),
  redirect_uri: z.string().optional(),
  state: z.string().optional().meta({ sensitive: true }),
  access_policy: AccessPolicySchema.optional(),
});

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Complete organization-scoped Sprites connector collection model. */
export const model = {
  type: "@josh/sprites/connectors",
  version: "2026.09.10.1",
  globalArguments: AuthSchema,
  resources: {
    connection: resource(
      ConnectionResponseSchema,
      "One organization connector with its current access policy",
    ),
    connections: resource(
      ConnectionsResponseSchema,
      "Complete organization connector collection",
    ),
    authorization: resource(
      AuthorizationSchema,
      "Sensitive provider authorization URL and OAuth state",
      "1d",
    ),
    deletion: resource(
      DeletionSchema,
      "ID of the deleted or already absent connector",
    ),
  },
  methods: {
    list: method(
      "List organization connectors",
      ListArgsSchema,
      "connections",
      ConnectionsResponseSchema,
      async (args, ctx) => {
        return await jsonRequest(
          ctx,
          "GET",
          "/v1/oauth/connections",
          ConnectionsResponseSchema,
          { query: { provider: args.provider } },
        );
      },
    ),
    createApiKey: method(
      "Create an API-key connector without automatic retries",
      CreateApiKeyArgsSchema,
      "connection",
      ConnectionResponseSchema,
      async (args, ctx) => {
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
        return await jsonRequest(
          ctx,
          "GET",
          `/v1/oauth/connections/${segment(args.id)}`,
          ConnectionResponseSchema,
        );
      },
    ),
    updatePolicy: method(
      "Replace a connector access policy",
      PolicyArgsSchema,
      "connection",
      ConnectionResponseSchema,
      (args, ctx) =>
        jsonRequest(
          ctx,
          "PUT",
          `/v1/oauth/connections/${segment(args.id)}`,
          ConnectionResponseSchema,
          { json: { access_policy: args.access_policy } },
        ),
    ),
    delete: method(
      "Delete an organization connector",
      IdArgsSchema,
      "deletion",
      DeletionSchema,
      async (args, ctx) => {
        const path = `/v1/oauth/connections/${segment(args.id)}`;
        try {
          await emptyRequest(ctx, "DELETE", path);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        return { id: args.id };
      },
    ),
    authorize: method(
      "Start provider OAuth authorization",
      AuthorizeArgsSchema,
      "authorization",
      AuthorizationSchema,
      async (args, ctx) => {
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
