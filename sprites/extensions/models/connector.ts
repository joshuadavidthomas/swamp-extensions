// SPDX-License-Identifier: MIT
/** One organization connection to a provider, bound by its saved connection id. @module */
import { z } from "npm:zod@4.4.3";
import {
  ApiError,
  type Context,
  emptyRequest,
  jsonRequest,
  runMethod,
  segment,
} from "./_lib/core.ts";
import {
  AccessPolicySchema,
  ConnectionResponseSchema,
  ConnectionSchema,
} from "./_lib/connectors.ts";

const ConnectorArgsSchema = z.object({
  token: z.string().meta({ sensitive: true }).min(1).regex(
    /^[\x21-\x7e]+$/,
    "Use a bearer token without spaces or control characters.",
  ).describe("Organization token; use a vault reference."),
  baseUrl: z.url({ protocol: /^https$/, error: "Use an HTTPS API endpoint." })
    .optional().default("https://api.sprites.dev"),
  timeoutMs: z.number().int().min(1).max(2_147_483_647).optional().default(
    300_000,
  ),
  maxResponseBytes: z.number().int().min(1).max(1_073_741_824).optional()
    .default(
      67_108_864,
    ),
  name: z.string().min(1).describe("Local instance name for this connection."),
  provider: z.string().min(1),
});
type ConnectorContext = Context<z.output<typeof ConnectorArgsSchema>>;
function methodDescription(name: string): string {
  const methods: Record<string, { description: string }> = model.methods;
  return methods[name].description;
}
const AuthorizationSchema = z.object({
  authorize_url: z.string().meta({ sensitive: true }),
  state: z.string().meta({ sensitive: true }),
}).meta({ sensitive: true });

async function unbound(ctx: ConnectorContext): Promise<void> {
  const saved = z.object({ id: z.string() }).safeParse(
    await ctx.readResource("state"),
  );
  if (saved.success) {
    throw new Error(
      "A connection id is already saved. Use another instance to create a connection.",
    );
  }
}
async function savedId(ctx: ConnectorContext): Promise<string> {
  const saved = z.object({ id: z.string().min(1) }).safeParse(
    await ctx.readResource("state"),
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
    state: {
      schema: ConnectionSchema,
      description: "This organization connection and its current access policy",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    authorize: {
      schema: AuthorizationSchema,
      description: "Sensitive provider authorization URL and OAuth state",
      lifetime: "1d",
      garbageCollection: 10,
    },
  },
  methods: {
    createApiKey: {
      description:
        "Create an API-key connection; refuse an already bound instance",
      arguments: z.object({
        api_key: z.string().min(1).meta({ sensitive: true }).describe(
          "Use a vault reference for the provider credential.",
        ),
        access_policy: z.object(AccessPolicySchema.shape).describe(
          AccessPolicySchema.description!,
        ).optional(),
      }),
      execute: (
        args: {
          api_key: string;
          access_policy?: z.output<typeof AccessPolicySchema>;
        },
        ctx: ConnectorContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("createApiKey"),
          "state",
          ConnectionSchema,
          async () => {
            await unbound(ctx);
            return request(ctx, "POST", "/v1/oauth/connections/api_key", {
              json: { provider: ctx.globalArgs.provider, ...args },
            });
          },
        ),
    },
    provision: {
      description:
        "Provision a managed connection; refuse an already bound instance",
      arguments: z.object({}),
      execute: (_args: object, ctx: ConnectorContext) =>
        runMethod(
          ctx,
          methodDescription("provision"),
          "state",
          ConnectionSchema,
          async () => {
            await unbound(ctx);
            return request(ctx, "POST", "/v1/oauth/connections/provision", {
              json: { provider: ctx.globalArgs.provider },
            });
          },
        ),
    },
    authorize: {
      description:
        "Start provider OAuth authorization; refuse an already bound instance",
      arguments: z.object({
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
      execute: (
        args: {
          scopes?: string;
          add_scopes?: string;
          redirect_uri?: string;
          state?: string;
        },
        ctx: ConnectorContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("authorize"),
          "authorize",
          AuthorizationSchema,
          async () => {
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
    },
    callback: {
      description:
        "Complete the saved pending OAuth authorization without automatic retries",
      arguments: z.object({
        code: z.string().min(1).meta({ sensitive: true }),
        redirect_uri: z.string().optional(),
        access_policy: z.object(AccessPolicySchema.shape).describe(
          AccessPolicySchema.description!,
        ).optional(),
      }),
      execute: (
        args: {
          code: string;
          redirect_uri?: string;
          access_policy?: z.output<typeof AccessPolicySchema>;
        },
        ctx: ConnectorContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("callback"),
          "state",
          ConnectionSchema,
          async () => {
            await unbound(ctx);
            const pending = AuthorizationSchema.safeParse(
              await ctx.readResource("authorize"),
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
              { json: { ...args, state: pending.data.state } },
            );
            await ctx.deleteResource("authorize");
            return connection;
          },
        ),
    },
    get: {
      description: "Read this saved organization connection",
      arguments: z.object({}),
      execute: (_args: object, ctx: ConnectorContext) =>
        runMethod(
          ctx,
          methodDescription("get"),
          "state",
          ConnectionSchema,
          async () => request(ctx, "GET", path(await savedId(ctx))),
        ),
    },
    updatePolicy: {
      description: "Replace this connection's complete access policy",
      arguments: z.object({
        access_policy: z.object(AccessPolicySchema.shape).describe(
          AccessPolicySchema.description!,
        ),
      }),
      execute: (
        args: { access_policy: z.output<typeof AccessPolicySchema> },
        ctx: ConnectorContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("updatePolicy"),
          "state",
          ConnectionSchema,
          async () =>
            request(ctx, "PUT", path(await savedId(ctx)), { json: args }),
        ),
    },
    delete: {
      description:
        "Delete this connection; an already absent connection succeeds",
      arguments: z.object({}),
      execute: (_args: object, ctx: ConnectorContext) =>
        runMethod(ctx, methodDescription("delete"), null, async () => {
          const id = await savedId(ctx);
          try {
            await emptyRequest(ctx, "DELETE", path(id));
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) {
              throw error;
            }
          }
          await ctx.deleteResource("state");
        }),
    },
    lookup: {
      description: "Adopt an existing organization connection id",
      arguments: z.object({ id: z.string().min(1) }),
      execute: (args: { id: string }, ctx: ConnectorContext) =>
        runMethod(
          ctx,
          methodDescription("lookup"),
          "state",
          ConnectionSchema,
          () => request(ctx, "GET", path(args.id)),
        ),
    },
  },
};
