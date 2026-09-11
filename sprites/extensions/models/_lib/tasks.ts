// SPDX-License-Identifier: MIT
/** Sprite task collection, read through the local management socket. @module */
import { z } from "zod";
import { Empty, method, resource } from "./core.ts";
import { executeHttp } from "./exec.ts";
import { type ManagementExec, read } from "./local-api.ts";
import { type SpriteContext, verifySprite } from "./sprite.ts";

export const ManagementResourceName = z.string().min(1).max(256).refine(
  (name) => name !== "." && name !== "..",
  "A management resource name must not be a dot segment.",
);
const units: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  "µs": 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};
/** Tasks accept seconds or Go-style durations, bounded to the provider's one-hour limit. */
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

/** Collection methods with an explicit local exec boundary. */
export function createMethods(execute: ManagementExec = executeHttp) {
  return {
    listTasks: method(
      "List active task holds through the Sprite management socket",
      Empty,
      "tasks",
      Tasks,
      async (_args, ctx: SpriteContext) => {
        // Even local reads start a process. Require the saved identity for every exec.
        await verifySprite(ctx);
        return read(ctx, ctx.globalArgs.name, "/v1/tasks", Tasks, execute);
      },
    ),
  };
}
export const tasksResources = {
  tasks: resource(
    Tasks,
    "Observed task holds; this snapshot does not keep a Sprite awake",
    "7d",
  ),
};
export const tasksMethods = createMethods();
