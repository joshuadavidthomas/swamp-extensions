// SPDX-License-Identifier: MIT
/** The Sprite's local management API at /.sprite/api.sock, reached with curl through authenticated exec.
 * None of these routes appear in sprites.dev/api or docs.sprites.dev; they were verified live. @module */
import { z } from "npm:zod@4.4.3";
import { type Context, runMethod, segment } from "./_lib/core.ts";
import { executeHttp } from "./_lib/exec.ts";
import { type ManagementExec, read, send } from "./_lib/local-api.ts";
import { Task, TaskExpiry } from "./_lib/tasks.ts";
import { bindSprite, boundSprite, SpriteIdentity } from "./_lib/sprite.ts";

const TaskArgsSchema = z.object({
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
  name: z.string().min(1).max(256).refine(
    (name) => name !== "." && name !== "..",
    "A management resource name must not be a dot segment.",
  ),
});
type TaskContext = Context<z.output<typeof TaskArgsSchema>> & {
  managementExec?: ManagementExec;
};
function methodDescription(name: string): string {
  const methods: Record<string, { description: string }> = model.methods;
  return methods[name].description;
}
const TaskRecord = Task.extend({ sprite: SpriteIdentity });

function path(ctx: TaskContext): `/v1/tasks/${string}` {
  return `/v1/tasks/${segment(ctx.globalArgs.name)}`;
}
async function record(
  ctx: TaskContext,
  sprite: z.output<typeof SpriteIdentity>,
  execute: ManagementExec,
) {
  return {
    ...await read(ctx, ctx.globalArgs.sprite, path(ctx), Task, execute),
    sprite: { name: sprite.name, id: sprite.id },
  };
}

/** One task hold on one Sprite; saved snapshots do not renew the hold. */
export const model = {
  type: "@josh/sprites/task",
  version: "2026.09.11.1",
  globalArguments: TaskArgsSchema,
  resources: {
    state: {
      schema: TaskRecord,
      description:
        "Observed task expiry and its Sprite identity; refresh explicitly when needed",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description:
        "Create a task hold; an existing name fails rather than being refreshed",
      arguments: z.object({ expire: z.union(TaskExpiry.options) }),
      execute: (
        args: { expire: z.output<typeof TaskExpiry> },
        ctx: TaskContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("create"),
          "state",
          TaskRecord,
          async () => {
            const execute = ctx.managementExec ?? executeHttp;
            const sprite = await bindSprite(ctx);
            await send(ctx, ctx.globalArgs.sprite, {
              method: "POST",
              path: "/v1/tasks",
              body: { name: ctx.globalArgs.name, expire: args.expire },
              statuses: [201],
            }, execute);
            return record(ctx, sprite, execute);
          },
        ),
    },
    get: {
      description: "Read an active task hold and save it",
      arguments: z.object({}),
      execute: (_args: object, ctx: TaskContext) =>
        runMethod(
          ctx,
          methodDescription("get"),
          "state",
          TaskRecord,
          async () =>
            record(
              ctx,
              await bindSprite(ctx),
              ctx.managementExec ?? executeHttp,
            ),
        ),
    },
    refresh: {
      description: "Refresh this task hold, or create it if absent",
      arguments: z.object({ expire: z.union(TaskExpiry.options) }),
      execute: (
        args: { expire: z.output<typeof TaskExpiry> },
        ctx: TaskContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("refresh"),
          "state",
          TaskRecord,
          async () => {
            const execute = ctx.managementExec ?? executeHttp;
            const sprite = await boundSprite(ctx);
            await send(ctx, ctx.globalArgs.sprite, {
              method: "PUT",
              path: path(ctx),
              body: { expire: args.expire },
              statuses: [200],
            }, execute);
            return record(ctx, sprite, execute);
          },
        ),
    },
    delete: {
      description: "Release this task hold; an already absent task succeeds",
      arguments: z.object({}),
      execute: (_args: object, ctx: TaskContext) =>
        runMethod(
          ctx,
          methodDescription("delete"),
          null,
          async () => {
            await boundSprite(ctx);
            await send(ctx, ctx.globalArgs.sprite, {
              method: "DELETE",
              path: path(ctx),
              statuses: [204, 404],
            }, ctx.managementExec ?? executeHttp);
            await ctx.deleteResource("state");
          },
        ),
    },
  },
};
