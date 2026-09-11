// SPDX-License-Identifier: MIT
/** Organization connector schemas and collection read; credentials are excluded. @module */
import { z } from "zod";
import { jsonRequest, method, resource } from "./core.ts";

export const AccessPolicySchema = z.object({
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

export const ConnectionSchema = z.object({
  id: z.string(),
  provider: ConnectorProviderSchema,
  provider_account_id: z.string(),
  provider_account_name: z.string().optional(),
  scopes: z.string().nullish(),
  connection_type: z.enum([
    "oauth",
    "api_key",
    "provisioned",
    "internal",
  ]).optional(),
  access_policy: AccessPolicySchema.optional(),
  provider_info: z.record(z.string(), z.json()).optional(),
  user_id: z.string().nullish(),
  token_expires_at: z.iso.datetime({ offset: true }).nullish(),
  inserted_at: z.iso.datetime({ offset: true }).optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
  usage_snippet: z.string().optional(),
});

export const ConnectionResponseSchema = z.object({
  connection: ConnectionSchema,
});

export const ConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionSchema),
});

export const connectorsResources = {
  connectors: resource(
    ConnectionsResponseSchema,
    "Complete organization connector collection",
  ),
};
export const connectorsMethods = {
  listConnectors: method(
    "List organization connectors",
    z.object({ provider: z.string().optional() }),
    "connectors",
    ConnectionsResponseSchema,
    (args, ctx) =>
      jsonRequest(
        ctx,
        "GET",
        "/v1/oauth/connections",
        ConnectionsResponseSchema,
        { query: { provider: args.provider } },
      ),
  ),
};
