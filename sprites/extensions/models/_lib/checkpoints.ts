// SPDX-License-Identifier: MIT
/** Sprite checkpoint creation, discovery, and restoration. @module */
import { z } from "zod";
import {
  type Context,
  Empty,
  jsonRequest,
  method,
  ndjson,
  requireComplete,
  resource,
} from "./core.ts";
import { type SpriteContext, spritePath } from "./sprite.ts";

export const Checkpoint = z.object({
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
export const CheckpointEvents = z.object({
  events: z.array(CheckpointEvent),
});
const Checkpoints = z.object({
  checkpoints: z.array(Checkpoint),
});

export async function checkpointStream(
  ctx: Context,
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
  checkpoints: resource(Checkpoints, "Sprite checkpoints"),
};

export const checkpointsMethods = {
  listCheckpoints: method(
    "List Sprite checkpoints",
    Empty,
    "checkpoints",
    Checkpoints,
    async (_args, ctx: SpriteContext) => ({
      checkpoints: await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx.globalArgs.name, "/checkpoints"),
        z.array(Checkpoint),
      ),
    }),
  ),
};
