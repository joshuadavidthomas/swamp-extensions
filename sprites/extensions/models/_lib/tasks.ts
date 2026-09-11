// SPDX-License-Identifier: MIT
/** Sprite task protocol schemas and collection read. @module */
import { z } from "npm:zod@4.4.3";
import { executeHttp } from "./exec.ts";
import { type ManagementExec, read } from "./local-api.ts";
import { type SpriteContext, verifySprite } from "./sprite.ts";

const units: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  "µs": 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};
export const TaskExpiry = z.union([
  z.number().int().positive().max(3600),
  z.string().min(1).max(128).refine((text) => {
    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)];
    const seconds = parts.reduce(
      (sum, part) => sum + Number(part[1]) * units[part[2]],
      0,
    );
    return parts.map((part) => part[0]).join("") === text && seconds > 0 &&
      seconds <= 3600;
  }, "Task expiration must be a positive duration of at most one hour."),
]);
export const Task = z.object({
  name: z.string(),
  started_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
});
export const Tasks = z.object({ tasks: z.array(Task) });

/** Read active task holds through an injectable local management transport. */
export async function listTasks(
  ctx: SpriteContext,
  execute: ManagementExec = executeHttp,
): Promise<z.output<typeof Tasks>> {
  await verifySprite(ctx);
  return read(ctx, ctx.globalArgs.name, "/v1/tasks", Tasks, execute);
}
