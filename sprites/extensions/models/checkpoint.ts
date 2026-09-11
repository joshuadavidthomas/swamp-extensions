// SPDX-License-Identifier: MIT
/** One named slot holding a Sprite checkpoint. @module */
import { z } from "npm:zod@4.4.3";
import { jsonRequest, runMethod, segment, withHandles } from "./_lib/core.ts";
import {
  Checkpoint,
  CheckpointEvents,
  checkpointStream,
} from "./_lib/checkpoints.ts";
import {
  bindSprite,
  boundSprite,
  type ChildContext,
  SpriteIdentity,
  spritePath,
} from "./_lib/sprite.ts";

const CheckpointArgsSchema = z.object({
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
  sprite: z.string().min(1).describe("Name of the Sprite this belongs to."),
  name: z.string().min(1).describe(
    "Local slot name for a saved checkpoint id.",
  ),
});
const CheckpointRecord = Checkpoint.extend({ sprite: SpriteIdentity });

function methodDescription(name: string): string {
  const methods: Record<string, { description: string }> = model.methods;
  return methods[name].description;
}
function path(ctx: ChildContext, id: string, suffix = ""): string {
  return spritePath(
    ctx.globalArgs.sprite,
    `/checkpoints/${segment(id)}${suffix}`,
  );
}
async function savedId(ctx: ChildContext): Promise<string> {
  return CheckpointRecord.parse(await ctx.readResource("state")).id;
}
async function record(
  ctx: ChildContext,
  id: string,
  sprite: z.output<typeof SpriteIdentity>,
) {
  return {
    ...await jsonRequest(ctx, "GET", path(ctx, id), Checkpoint),
    sprite: { name: sprite.name, id: sprite.id },
  };
}

/** A checkpoint slot can be retaken; its previous id remains in resource history. */
export const model = {
  type: "@josh/sprites/checkpoint",
  version: "2026.09.11.1",
  globalArguments: CheckpointArgsSchema,
  resources: {
    state: {
      schema: CheckpointRecord,
      description: "Saved checkpoint and its Sprite identity",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    create: {
      schema: CheckpointEvents,
      description: "Checkpoint creation progress",
      lifetime: "7d",
      garbageCollection: 10,
    },
    restore: {
      schema: CheckpointEvents,
      description: "Checkpoint restoration progress",
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description:
        "Take a fresh checkpoint and point this slot at it; a bound slot is retaken and its old id stays in history",
      arguments: z.object({ comment: z.string().optional() }),
      execute: (args: { comment?: string }, ctx: ChildContext) =>
        runMethod(
          ctx,
          methodDescription("create"),
          "state",
          CheckpointRecord,
          async () => {
            const sprite = await bindSprite(ctx);
            const events = await checkpointStream(
              ctx,
              spritePath(ctx.globalArgs.sprite, "/checkpoint"),
              args,
            );
            // The complete event carries progress text, not the new id, so take the newest listed
            // checkpoint. A checkpoint someone else creates at the same moment could win that race.
            const checkpoints = await jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.sprite, "/checkpoints"),
              z.array(Checkpoint),
            );
            const newest = checkpoints.reduce<
              z.output<typeof Checkpoint> | undefined
            >(
              (latest, candidate) =>
                !latest ||
                  Date.parse(candidate.create_time) >
                    Date.parse(latest.create_time)
                  ? candidate
                  : latest,
              undefined,
            );
            if (!newest) {
              throw new Error(
                "Checkpoint creation completed but no checkpoint was listed.",
              );
            }
            const progress = await ctx.writeResource(
              "create",
              "create",
              CheckpointEvents.parse(events),
            );
            return withHandles({
              ...newest,
              sprite: { name: sprite.name, id: sprite.id },
            }, [progress]);
          },
        ),
    },
    get: {
      description: "Read the checkpoint id saved in this slot",
      arguments: z.object({}),
      execute: (_args: object, ctx: ChildContext) =>
        runMethod(
          ctx,
          methodDescription("get"),
          "state",
          CheckpointRecord,
          async () => {
            const sprite = await boundSprite(ctx);
            return record(ctx, await savedId(ctx), sprite);
          },
        ),
    },
    restore: {
      description: "Restore the checkpoint id saved in this slot",
      arguments: z.object({}),
      execute: (_args: object, ctx: ChildContext) =>
        runMethod(
          ctx,
          methodDescription("restore"),
          "restore",
          CheckpointEvents,
          async () => {
            await boundSprite(ctx);
            return checkpointStream(
              ctx,
              path(ctx, await savedId(ctx), "/restore"),
            );
          },
        ),
    },
    lookup: {
      description: "Adopt an existing checkpoint id into this slot",
      arguments: z.object({ checkpoint_id: z.string().min(1) }),
      execute: (args: { checkpoint_id: string }, ctx: ChildContext) =>
        runMethod(
          ctx,
          methodDescription("lookup"),
          "state",
          CheckpointRecord,
          async () => record(ctx, args.checkpoint_id, await bindSprite(ctx)),
        ),
    },
  },
};
