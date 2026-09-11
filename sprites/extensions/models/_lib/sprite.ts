// SPDX-License-Identifier: MIT
/** Sprite identity and base lifecycle routes. @module */
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  ApiError,
  AuthSchema,
  type Context,
  deadline,
  Empty,
  emptyRequest,
  Environment,
  jsonRequest,
  method,
  resource,
  responseBytes,
  segment,
} from "./core.ts";

/** One model instance owns one named Sprite in the token's organization. */
export const SpriteArgsSchema = AuthSchema.extend({
  name: z.string().min(1).describe(
    "Sprite name within the token's organization.",
  ),
});
/** Single-Sprite method context. */
export type SpriteContext = Context<z.output<typeof SpriteArgsSchema>>;
/** A child of one Sprite (service, checkpoint, task) names its parent and nothing else about it. */
export const ChildArgsSchema = AuthSchema.extend({
  sprite: z.string().min(1).describe(
    "Name of the Sprite this belongs to.",
  ),
});
/** Child method context. */
export type ChildContext = Context<z.output<typeof ChildArgsSchema>>;
/** The Sprite a child instance bound to. Mutations refuse a Sprite whose id has changed since. */
export const SpriteIdentity = z.object({ name: z.string(), id: z.string() });
/** API response metadata; environment values are intentionally excluded. */
export const SpriteResponse = z.object({
  id: z.string(),
  name: z.string(),
  organization: z.string(),
  url: z.string(),
  status: z.enum(["cold", "warm", "running"]),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  url_settings: z.object({
    auth: z.enum(["sprite", "public"]),
    private_access: z.enum(["admins", "org_users"]).optional(),
  }).nullish(),
  version: z.string().nullish(),
  environment_version: z.string().nullish(),
  labels: z.array(z.string()).optional(),
  last_running_at: z.iso.datetime({ offset: true }).nullish(),
  last_warming_at: z.iso.datetime({ offset: true }).nullish(),
});
const UrlProbe = z.object({
  bodyBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const RequestUrlSettings = z.object({
  auth: z.enum(["sprite", "public"]).optional(),
  private_access: z.enum(["admins", "org_users"]).optional(),
});
const SpriteConfig = z.object({
  ram_mb: z.number().positive().optional(),
  cpus: z.number().positive().optional(),
  region: z.string().min(1).optional(),
  storage_gb: z.number().positive().optional(),
});

/** Construct a path relative to a named Sprite. */
export function spritePath(name: string, suffix = ""): string {
  return `/v1/sprites/${segment(name)}${suffix}`;
}
/** Read the Sprite and refuse it when its id is not the one this instance saved. */
async function verifyIdentity(
  ctx: Context,
  name: string,
  savedId: string | undefined,
): Promise<z.output<typeof SpriteResponse>> {
  const current = await jsonRequest(
    ctx,
    "GET",
    spritePath(name),
    SpriteResponse,
  );
  if (savedId !== current.id) {
    throw new Error(
      "The Sprite was replaced since its saved state. Run lookup and verify the new ID before mutating it.",
    );
  }
  return current;
}
/** Sprite model: mutations require the identity saved by create or lookup. */
export async function verifySprite(
  ctx: SpriteContext,
): Promise<z.output<typeof SpriteResponse>> {
  const value = await ctx.readResource("state");
  if (value === null) {
    throw new Error(
      "No Sprite identity is saved. Run lookup and verify its ID before mutating it.",
    );
  }
  const stored = z.object({ id: SpriteResponse.shape.id }).safeParse(value);
  return verifyIdentity(
    ctx,
    ctx.globalArgs.name,
    stored.success ? stored.data.id : undefined,
  );
}
/** The Sprite id a child instance saved in its own state resource, if it has bound. */
async function savedParent(
  ctx: ChildContext,
  spec: string,
): Promise<string | undefined> {
  const stored = z.object({ sprite: SpriteIdentity }).safeParse(
    await ctx.readResource(spec),
  );
  return stored.success ? stored.data.sprite.id : undefined;
}
/** Child models, when creating or looking up: verify a bound Sprite, or read an unbound one so the caller can bind it. */
export async function bindSprite(
  ctx: ChildContext,
  spec: string,
): Promise<z.output<typeof SpriteResponse>> {
  const savedId = await savedParent(ctx, spec);
  if (savedId === undefined) {
    return jsonRequest(
      ctx,
      "GET",
      spritePath(ctx.globalArgs.sprite),
      SpriteResponse,
    );
  }
  return verifyIdentity(ctx, ctx.globalArgs.sprite, savedId);
}
/** Child models, for every other method: the instance must already be bound to its Sprite. */
export async function boundSprite(
  ctx: ChildContext,
  spec: string,
): Promise<z.output<typeof SpriteResponse>> {
  const savedId = await savedParent(ctx, spec);
  if (savedId === undefined) {
    throw new Error(
      `No Sprite identity is saved for this ${spec}. Create or look it up first.`,
    );
  }
  return verifyIdentity(ctx, ctx.globalArgs.sprite, savedId);
}

export const spriteResources = {
  state: resource(SpriteResponse, "Current provider metadata for this Sprite"),
  urlProbe: resource(
    UrlProbe,
    "Authenticated root URL response fingerprint; not a general application health guarantee",
    "7d",
  ),
};

export const spriteMethods = {
  create: method(
    "Create the configured Sprite",
    z.object({
      config: SpriteConfig.optional(),
      environment: Environment.optional(),
      url_settings: RequestUrlSettings.optional(),
      labels: z.array(z.string()).optional(),
      wait_for_capacity: z.boolean().optional(),
      runtime: z.enum(["default", "dev"]).optional(),
    }),
    "state",
    SpriteResponse,
    async (args, ctx: SpriteContext) => {
      const saved = z.object({ id: z.string() }).safeParse(
        await ctx.readResource("state"),
      );
      if (saved.success) {
        throw new Error(
          "A Sprite identity is already saved. Use another instance to create a Sprite.",
        );
      }
      return await jsonRequest(ctx, "POST", "/v1/sprites", SpriteResponse, {
        json: { name: ctx.globalArgs.name, ...args },
      });
    },
  ),
  lookup: method(
    "Read the configured Sprite",
    Empty,
    "state",
    SpriteResponse,
    (_args, ctx: SpriteContext) =>
      jsonRequest(ctx, "GET", spritePath(ctx.globalArgs.name), SpriteResponse),
  ),
  update: method(
    "Update the configured Sprite",
    z.object({
      url_settings: RequestUrlSettings.optional(),
      labels: z.array(z.string()).optional(),
    }).refine(
      (value) => value.url_settings !== undefined || value.labels !== undefined,
      {
        message: "Provide url_settings or labels.",
      },
    ),
    "state",
    SpriteResponse,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(
        ctx,
        "PUT",
        spritePath(ctx.globalArgs.name),
        SpriteResponse,
        {
          json: args,
        },
      );
    },
  ),
  // Not in sprites.dev/api or docs.sprites.dev; verified live.
  upgrade: method(
    "Request a runtime upgrade; success only acknowledges provider acceptance",
    z.object({ version: z.string().min(1).optional() }),
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "POST",
        spritePath(ctx.globalArgs.name, "/upgrade"),
        args.version === undefined ? {} : { json: { version: args.version } },
      );
    },
  ),
  // Not in sprites.dev/api or docs.sprites.dev; verified live.
  restart: method(
    "Request a restart of the machine backing this Sprite",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "POST",
        spritePath(ctx.globalArgs.name, "/restart"),
      );
    },
  ),
  probeUrl: method(
    "Check the verified Sprite root URL and fingerprint its response",
    Empty,
    "urlProbe",
    UrlProbe,
    async (_args, ctx: SpriteContext) => {
      const operation = deadline(ctx);
      const { signal } = operation;
      try {
        const state = await verifySprite({ ...ctx, signal });
        const url = new URL(state.url);
        if (
          url.protocol !== "https:" || !url.hostname.endsWith(".sprites.app") ||
          !url.hostname.startsWith(`${ctx.globalArgs.name}-`) || url.username ||
          url.password || url.port || url.pathname !== "/" || url.search ||
          url.hash
        ) {
          throw new Error(
            "Sprite URL is not an expected provider-owned root URL; no credential was sent to it.",
          );
        }
        const response = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${ctx.globalArgs.token}` },
          redirect: "error",
          signal,
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`Sprite URL probe returned HTTP ${response.status}.`);
        }
        const bytes = await responseBytes(
          response,
          ctx.globalArgs.maxResponseBytes,
        );
        return {
          bodyBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } finally {
        operation.dispose();
      }
    },
  ),
  delete: method(
    "Delete the configured Sprite",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      try {
        await verifySprite(ctx);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
        await ctx.deleteResource("state");
        return;
      }
      try {
        await emptyRequest(ctx, "DELETE", spritePath(ctx.globalArgs.name));
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      await ctx.deleteResource("state");
    },
  ),
};
