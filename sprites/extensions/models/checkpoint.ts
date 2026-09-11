// SPDX-License-Identifier: MIT
/** One named slot holding a Sprite checkpoint. @module */
import { z } from "zod";
import {
  Empty,
  jsonRequest,
  method,
  resource,
  segment,
  withHandles,
} from "./_lib/core.ts";
import {
  Checkpoint,
  CheckpointEvents,
  checkpointStream,
} from "./_lib/checkpoints.ts";
import {
  bindSprite,
  boundSprite,
  ChildArgsSchema,
  type ChildContext,
  SpriteIdentity,
  spritePath,
} from "./_lib/sprite.ts";

const CheckpointArgsSchema = ChildArgsSchema.extend({
  name: z.string().min(1).describe(
    "Local slot name for a saved checkpoint id.",
  ),
});
const CheckpointRecord = Checkpoint.extend({ sprite: SpriteIdentity });

function path(ctx: ChildContext, id: string, suffix = ""): string {
  return spritePath(
    ctx.globalArgs.sprite,
    `/checkpoints/${segment(id)}${suffix}`,
  );
}
async function savedId(ctx: ChildContext): Promise<string> {
  return CheckpointRecord.parse(await ctx.readResource("checkpoint")).id;
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
    checkpoint: resource(
      CheckpointRecord,
      "Saved checkpoint and its Sprite identity",
    ),
    created: resource(CheckpointEvents, "Checkpoint creation progress", "7d"),
    restored: resource(
      CheckpointEvents,
      "Checkpoint restoration progress",
      "7d",
    ),
  },
  methods: {
    create: method(
      "Take a fresh checkpoint and point this slot at it; a bound slot is retaken and its old id stays in history",
      z.object({ comment: z.string().optional() }),
      "checkpoint",
      CheckpointRecord,
      async (args, ctx: ChildContext) => {
        const sprite = await bindSprite(ctx, "checkpoint");
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
              Date.parse(candidate.create_time) > Date.parse(latest.create_time)
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
          "created",
          "created",
          CheckpointEvents.parse(events),
        );
        return withHandles({
          ...newest,
          sprite: { name: sprite.name, id: sprite.id },
        }, [progress]);
      },
    ),
    get: method(
      "Read the checkpoint id saved in this slot",
      Empty,
      "checkpoint",
      CheckpointRecord,
      async (_args, ctx: ChildContext) => {
        const sprite = await boundSprite(ctx, "checkpoint");
        return record(ctx, await savedId(ctx), sprite);
      },
    ),
    restore: method(
      "Restore the checkpoint id saved in this slot",
      Empty,
      "restored",
      CheckpointEvents,
      async (_args, ctx: ChildContext) => {
        await boundSprite(ctx, "checkpoint");
        return checkpointStream(ctx, path(ctx, await savedId(ctx), "/restore"));
      },
    ),
    lookup: method(
      "Adopt an existing checkpoint id into this slot",
      z.object({ checkpoint_id: z.string().min(1) }),
      "checkpoint",
      CheckpointRecord,
      async (args, ctx: ChildContext) =>
        record(ctx, args.checkpoint_id, await bindSprite(ctx, "checkpoint")),
    ),
  },
};
