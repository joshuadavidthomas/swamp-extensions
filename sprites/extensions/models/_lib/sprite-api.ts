// SPDX-License-Identifier: MIT
/** Shared single-Sprite identity and provider response types. @module */
import { z } from "zod";
import { AuthSchema, type Context, jsonRequest, segment } from "./core.ts";

/** One model instance owns one named Sprite in the token's organization. */
export const SpriteArgsSchema = AuthSchema.extend({
  name: z.string().min(1).refine((name) => name !== "." && name !== "..", {
    error: "Sprite name must not be a relative path segment.",
  }).describe(
    "Sprite name within the token's organization.",
  ),
});
/** Single-Sprite method context. */
export type SpriteContext = Context<z.output<typeof SpriteArgsSchema>>;
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
/** Construct a path relative to the configured Sprite. */
export function spritePath(
  ctx: Pick<SpriteContext, "globalArgs">,
  suffix = "",
): string {
  return `/v1/sprites/${segment(ctx.globalArgs.name)}${suffix}`;
}
/** Fetch identity before a destructive operation and reject a replaced Sprite when state is available. */
export async function verifySprite(
  ctx: SpriteContext,
): Promise<z.output<typeof SpriteResponse>> {
  const current = await jsonRequest(
    ctx,
    "GET",
    spritePath(ctx),
    SpriteResponse,
  );
  const value = await ctx.readResource("state");
  if (value === null) {
    throw new Error(
      "No Sprite identity is saved. Run lookup and verify its ID before mutating it.",
    );
  }
  const stored = z.object({ id: SpriteResponse.shape.id }).safeParse(value);
  if (!stored.success || stored.data.id !== current.id) {
    throw new Error(
      "The Sprite was replaced since its saved state. Run lookup and verify the new ID before mutating it.",
    );
  }
  return current;
}
