// SPDX-License-Identifier: MIT
/** The Sprite's local management API at /.sprite/api.sock, reached with curl through authenticated exec.
 * None of these routes appear in sprites.dev/api or docs.sprites.dev; they were verified live. @module */
import { z } from "zod";
import { type Context, Empty, method, resource, segment } from "./_lib/core.ts";
import { executeHttp } from "./_lib/exec.ts";
import { type ManagementExec, read, send } from "./_lib/local-api.ts";
import { ManagementResourceName, Task, TaskExpiry } from "./_lib/tasks.ts";
import {
  bindSprite,
  boundSprite,
  ChildArgsSchema,
  SpriteIdentity,
} from "./_lib/sprite.ts";

const TaskArgsSchema = ChildArgsSchema.extend({ name: ManagementResourceName });
type TaskContext = Context<z.output<typeof TaskArgsSchema>>;
const TaskRecord = Task.extend({ sprite: SpriteIdentity });

function path(ctx: TaskContext): `/v1/tasks/${string}` {
  return `/v1/tasks/${segment(ctx.globalArgs.name)}`;
}

/** Methods take the native exec boundary so tests can replace the local socket transport. */
export function createMethods(execute: ManagementExec = executeHttp) {
  async function record(
    ctx: TaskContext,
    sprite: z.output<typeof SpriteIdentity>,
  ) {
    return {
      ...await read(ctx, ctx.globalArgs.sprite, path(ctx), Task, execute),
      sprite: { name: sprite.name, id: sprite.id },
    };
  }
  return {
    create: method(
      "Create a task hold; an existing name fails rather than being refreshed",
      z.object({ expire: TaskExpiry }),
      "state",
      TaskRecord,
      async (args, ctx: TaskContext) => {
        const sprite = await bindSprite(ctx);
        await send(ctx, ctx.globalArgs.sprite, {
          method: "POST",
          path: "/v1/tasks",
          body: { name: ctx.globalArgs.name, expire: args.expire },
          statuses: [201],
        }, execute);
        return record(ctx, sprite);
      },
    ),
    get: method(
      "Read an active task hold and save it",
      Empty,
      "state",
      TaskRecord,
      async (_args, ctx: TaskContext) => record(ctx, await bindSprite(ctx)),
    ),
    refresh: method(
      "Refresh this task hold, or create it if absent",
      z.object({ expire: TaskExpiry }),
      "state",
      TaskRecord,
      async (args, ctx: TaskContext) => {
        const sprite = await boundSprite(ctx);
        await send(ctx, ctx.globalArgs.sprite, {
          method: "PUT",
          path: path(ctx),
          body: { expire: args.expire },
          statuses: [200],
        }, execute);
        return record(ctx, sprite);
      },
    ),
    delete: method(
      "Release this task hold; an already absent task succeeds",
      Empty,
      null,
      async (_args, ctx: TaskContext) => {
        await boundSprite(ctx);
        await send(ctx, ctx.globalArgs.sprite, {
          method: "DELETE",
          path: path(ctx),
          statuses: [204, 404],
        }, execute);
        await ctx.deleteResource("state");
      },
    ),
  };
}

/** One task hold on one Sprite; saved snapshots do not renew the hold. */
export const model = {
  type: "@josh/sprites/task",
  version: "2026.09.11.1",
  globalArguments: TaskArgsSchema,
  resources: {
    state: resource(
      TaskRecord,
      "Observed task expiry and its Sprite identity; refresh explicitly when needed",
    ),
  },
  methods: createMethods(),
};
