// SPDX-License-Identifier: MIT
/** One organization connection to a provider, bound by its saved connection id. @module */
import { z } from "zod";
import {
  ApiError,
  AuthSchema,
  type Context,
  Empty,
  emptyRequest,
  jsonRequest,
  method,
  resource,
  segment,
} from "./_lib/core.ts";
import {
  AccessPolicySchema,
  ConnectionResponseSchema,
  ConnectionSchema,
} from "./_lib/connectors.ts";

const ConnectorArgsSchema = AuthSchema.extend({
  name: z.string().min(1).describe("Local instance name for this connection."),
  provider: z.string().min(1),
});
type ConnectorContext = Context<z.output<typeof ConnectorArgsSchema>>;
const AuthorizationSchema = z.object({
  authorize_url: z.string().meta({ sensitive: true }),
  state: z.string().meta({ sensitive: true }),
}).meta({ sensitive: true });

async function unbound(ctx: ConnectorContext): Promise<void> {
  const saved = z.object({ id: z.string() }).safeParse(
    await ctx.readResource("connection"),
  );
  if (saved.success) {
    throw new Error(
      "A connection id is already saved. Use another instance to create a connection.",
    );
  }
}
async function savedId(ctx: ConnectorContext): Promise<string> {
  const saved = z.object({ id: z.string().min(1) }).safeParse(
    await ctx.readResource("connection"),
  );
  if (!saved.success) {
    throw new Error(
      "No connection identity is saved. Create or look it up first.",
    );
  }
  return saved.data.id;
}
function path(id: string): string {
  return `/v1/oauth/connections/${segment(id)}`;
}
async function request(
  ctx: ConnectorContext,
  verb: string,
  route: string,
  options: Parameters<typeof jsonRequest>[4] = {},
) {
  return (await jsonRequest(
    ctx,
    verb,
    route,
    ConnectionResponseSchema,
    options,
  )).connection;
}

/** Bind once with a creation method, or adopt an existing connection with lookup. */
export const model = {
  type: "@josh/sprites/connector",
  version: "2026.09.11.1",
  globalArguments: ConnectorArgsSchema,
  resources: {
    connection: resource(
      ConnectionSchema,
      "This organization connection and its current access policy",
    ),
    pending: resource(
      AuthorizationSchema,
      "Sensitive provider authorization URL and OAuth state",
      "1d",
    ),
  },
  methods: {
    createApiKey: method(
      "Create an API-key connection; refuse an already bound instance",
      z.object({
        api_key: z.string().min(1).meta({ sensitive: true }).describe(
          "Use a vault reference for the provider credential.",
        ),
        access_policy: AccessPolicySchema.optional(),
      }),
      "connection",
      ConnectionSchema,
      async (args, ctx: ConnectorContext) => {
        await unbound(ctx);
        return request(ctx, "POST", "/v1/oauth/connections/api_key", {
          json: { provider: ctx.globalArgs.provider, ...args },
        });
      },
    ),
    provision: method(
      "Provision a managed connection; refuse an already bound instance",
      Empty,
      "connection",
      ConnectionSchema,
      async (_args, ctx: ConnectorContext) => {
        await unbound(ctx);
        return request(ctx, "POST", "/v1/oauth/connections/provision", {
          json: { provider: ctx.globalArgs.provider },
        });
      },
    ),
    authorize: method(
      "Start provider OAuth authorization; refuse an already bound instance",
      z.object({
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
      }),
      "pending",
      AuthorizationSchema,
      async (args, ctx: ConnectorContext) => {
        await unbound(ctx);
        return jsonRequest(
          ctx,
          "GET",
          `/v1/oauth/${segment(ctx.globalArgs.provider)}/authorize`,
          AuthorizationSchema,
          { query: args },
        );
      },
    ),
    callback: method(
      "Complete the saved pending OAuth authorization without automatic retries",
      z.object({
        code: z.string().min(1).meta({ sensitive: true }),
        redirect_uri: z.string().optional(),
        access_policy: AccessPolicySchema.optional(),
      }),
      "connection",
      ConnectionSchema,
      async (args, ctx: ConnectorContext) => {
        await unbound(ctx);
        const pending = AuthorizationSchema.safeParse(
          await ctx.readResource("pending"),
        );
        if (!pending.success) {
          throw new Error(
            "No pending OAuth authorization is saved. Run authorize first.",
          );
        }
        const connection = await request(
          ctx,
          "POST",
          `/v1/oauth/${segment(ctx.globalArgs.provider)}/callback`,
          {
            json: { ...args, state: pending.data.state },
          },
        );
        await ctx.deleteResource("pending");
        return connection;
      },
    ),
    get: method(
      "Read this saved organization connection",
      Empty,
      "connection",
      ConnectionSchema,
      async (_args, ctx: ConnectorContext) =>
        request(ctx, "GET", path(await savedId(ctx))),
    ),
    updatePolicy: method(
      "Replace this connection's complete access policy",
      z.object({ access_policy: AccessPolicySchema }),
      "connection",
      ConnectionSchema,
      async (args, ctx: ConnectorContext) =>
        request(ctx, "PUT", path(await savedId(ctx)), { json: args }),
    ),
    delete: method(
      "Delete this connection; an already absent connection succeeds",
      Empty,
      null,
      async (_args, ctx: ConnectorContext) => {
        const id = await savedId(ctx);
        try {
          await emptyRequest(ctx, "DELETE", path(id));
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        await ctx.deleteResource("connection");
      },
    ),
    lookup: method(
      "Adopt an existing organization connection id",
      z.object({ id: z.string().min(1) }),
      "connection",
      ConnectionSchema,
      (args, ctx: ConnectorContext) => request(ctx, "GET", path(args.id)),
    ),
  },
};
