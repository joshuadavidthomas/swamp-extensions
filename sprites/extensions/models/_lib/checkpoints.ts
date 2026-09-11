// SPDX-License-Identifier: MIT
/** Sprite checkpoint creation, discovery, and restoration. @module */
import { z } from "zod";
import {
  Empty,
  jsonRequest,
  method,
  ndjson,
  requireComplete,
  resource,
  segment,
} from "./core.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite.ts";

const CheckpointId = z.string().min(1);
const Checkpoint = z.object({
  id: z.string(),
  create_time: z.iso.datetime({ offset: true }),
  comment: z.string().optional(),
  health: z.string().optional(),
  source_id: z.string().optional(),
});
const CheckpointEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("info"),
    data: z.string(),
    time: z.iso.datetime({ offset: true }),
  }),
  z.object({
    type: z.literal("complete"),
    data: z.string(),
    time: z.iso.datetime({ offset: true }),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
    time: z.iso.datetime({ offset: true }),
  }),
]);
const CheckpointEvents = z.object({
  events: z.array(CheckpointEvent),
});
const Checkpoints = z.object({
  checkpoints: z.array(Checkpoint),
});

function checkpointPath(ctx: SpriteContext, id: string): string {
  return spritePath(ctx, `/checkpoints/${segment(id)}`);
}
async function checkpointStream(
  ctx: SpriteContext,
  path: string,
  json?: unknown,
): Promise<z.input<typeof CheckpointEvents>> {
  const events = await ndjson(
    ctx,
    "POST",
    path,
    CheckpointEvent,
    { json },
  );
  return { events: requireComplete(events, path) };
}

export const checkpointsResources = {
  checkpointCreated: resource(CheckpointEvents, "Checkpoint creation progress"),
  checkpoints: resource(Checkpoints, "Sprite checkpoints"),
  checkpoint: resource(Checkpoint, "One Sprite checkpoint"),
  checkpointRestored: resource(
    CheckpointEvents,
    "Checkpoint restoration progress",
  ),
};

export const checkpointsMethods = {
  createCheckpoint: method(
    "Create a Sprite checkpoint",
    z.object({ comment: z.string().optional() }),
    "checkpointCreated",
    CheckpointEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await checkpointStream(
        ctx,
        spritePath(ctx, "/checkpoint"),
        args,
      );
    },
  ),
  listCheckpoints: method(
    "List Sprite checkpoints",
    Empty,
    "checkpoints",
    Checkpoints,
    async (_args, ctx: SpriteContext) => ({
      checkpoints: await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx, "/checkpoints"),
        z.array(Checkpoint),
      ),
    }),
  ),
  getCheckpoint: method(
    "Read a Sprite checkpoint",
    z.object({ checkpoint_id: CheckpointId }),
    "checkpoint",
    Checkpoint,
    (args, ctx: SpriteContext) =>
      jsonRequest(
        ctx,
        "GET",
        checkpointPath(ctx, args.checkpoint_id),
        Checkpoint,
      ),
  ),
  restoreCheckpoint: method(
    "Restore a Sprite checkpoint",
    z.object({ checkpoint_id: CheckpointId }),
    "checkpointRestored",
    CheckpointEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await checkpointStream(
        ctx,
        `${checkpointPath(ctx, args.checkpoint_id)}/restore`,
      );
    },
  ),
};
