// SPDX-License-Identifier: MIT
/** Sprite identity and shared identity checks. @module */
import { z } from "npm:zod@4.4.3";
import { type Auth, type Context, jsonRequest, segment } from "./core.ts";

export type SpriteContext = Context<Auth & { name: string }>;
export type ChildContext = Context<Auth & { sprite: string }>;
export const SpriteIdentity = z.object({ name: z.string(), id: z.string() });
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
export const UrlProbe = z.object({
  bodyBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export function spritePath(name: string, suffix = ""): string {
  return `/v1/sprites/${segment(name)}${suffix}`;
}
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
async function savedParent(ctx: ChildContext): Promise<string | undefined> {
  const stored = z.object({ sprite: SpriteIdentity }).safeParse(
    await ctx.readResource("state"),
  );
  return stored.success ? stored.data.sprite.id : undefined;
}
export async function bindSprite(
  ctx: ChildContext,
): Promise<z.output<typeof SpriteResponse>> {
  const savedId = await savedParent(ctx);
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
export async function boundSprite(
  ctx: ChildContext,
): Promise<z.output<typeof SpriteResponse>> {
  const savedId = await savedParent(ctx);
  if (savedId === undefined) {
    throw new Error("No Sprite identity is saved. Create or look it up first.");
  }
  return verifyIdentity(ctx, ctx.globalArgs.sprite, savedId);
}
