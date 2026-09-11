// SPDX-License-Identifier: MIT
/** One service on a Sprite: its definition, lifecycle, logs, and signal. @module */
import { z } from "zod";
import {
  ApiError,
  type Context,
  Empty,
  emptyRequest,
  Environment,
  jsonRequest,
  method,
  resource,
  segment,
  withHandles,
} from "./_lib/core.ts";
import { executeHttp } from "./_lib/exec.ts";
import { type ManagementExec, send } from "./_lib/local-api.ts";
import { Service, ServiceEvents, serviceStream } from "./_lib/services.ts";
import {
  bindSprite,
  boundSprite,
  ChildArgsSchema,
  SpriteIdentity,
  spritePath,
} from "./_lib/sprite.ts";

const ServiceArgsSchema = ChildArgsSchema.extend({
  service_name: z.string().min(1).describe("Service name on that Sprite."),
});
type ServiceContext = Context<z.output<typeof ServiceArgsSchema>>;
/** What the API reports for this service, plus the Sprite it was bound to. */
const ServiceRecord = Service.extend({ sprite: SpriteIdentity });

function path(ctx: ServiceContext, suffix = ""): string {
  return spritePath(
    ctx.globalArgs.sprite,
    `/services/${segment(ctx.globalArgs.service_name)}${suffix}`,
  );
}
/** Read the service after a change and save it with the Sprite identity that was just verified. */
async function record(
  ctx: ServiceContext,
  sprite: z.output<typeof SpriteIdentity>,
): Promise<z.input<typeof ServiceRecord>> {
  return {
    ...await jsonRequest(ctx, "GET", path(ctx), Service),
    sprite: { name: sprite.name, id: sprite.id },
  };
}

/** Methods take the native exec boundary so tests can replace the local socket transport. */
export function createMethods(execute: ManagementExec = executeHttp) {
  return {
    put: method(
      "Create or update this service, then save its definition",
      z.object({
        service: z.object({
          cmd: z.string().min(1),
          args: z.array(z.string()).default([]),
          env: Environment.optional(),
          dir: z.string().optional(),
          needs: z.array(z.string()).default([]),
          http_port: z.number().int().nullable().optional(),
        }),
        duration: z.string().min(1).optional(),
      }),
      "service",
      ServiceRecord,
      async (args, ctx: ServiceContext) => {
        const sprite = await bindSprite(ctx, "service");
        const events = await serviceStream(
          ctx,
          "PUT",
          path(ctx),
          { query: { duration: args.duration }, json: args.service },
          "startup",
        );
        const progress = await ctx.writeResource(
          "put",
          "put",
          ServiceEvents.parse(events),
        );
        return withHandles(await record(ctx, sprite), [progress]);
      },
    ),
    get: method(
      "Read this service and save it",
      Empty,
      "service",
      ServiceRecord,
      async (_args, ctx: ServiceContext) =>
        record(ctx, await bindSprite(ctx, "service")),
    ),
    start: method(
      "Start this service",
      z.object({ duration: z.string().min(1).optional() }),
      "started",
      ServiceEvents,
      async (args, ctx: ServiceContext) => {
        await boundSprite(ctx, "service");
        return await serviceStream(
          ctx,
          "POST",
          path(ctx, "/start"),
          { query: { duration: args.duration } },
          "startup",
        );
      },
    ),
    stop: method(
      "Stop this service",
      z.object({ timeout: z.string().min(1).optional() }),
      "stopped",
      ServiceEvents,
      async (args, ctx: ServiceContext) => {
        await boundSprite(ctx, "service");
        return await serviceStream(
          ctx,
          "POST",
          path(ctx, "/stop"),
          { query: { timeout: args.timeout } },
          "progress",
        );
      },
    ),
    restart: method(
      "Restart this service",
      z.object({ duration: z.string().min(1).optional() }),
      "restarted",
      ServiceEvents,
      async (args, ctx: ServiceContext) => {
        await boundSprite(ctx, "service");
        return await serviceStream(
          ctx,
          "POST",
          path(ctx, "/restart"),
          { query: { duration: args.duration } },
          "startup",
        );
      },
    ),
    logs: method(
      "Read a bounded portion of this service's log stream",
      z.object({
        lines: z.number().int().nonnegative().optional(),
        duration: z.string().min(1).optional(),
      }),
      "logs",
      ServiceEvents,
      async (args, ctx: ServiceContext) => {
        await boundSprite(ctx, "service");
        return await serviceStream(
          ctx,
          "GET",
          path(ctx, "/logs"),
          { query: { lines: args.lines, duration: args.duration } },
          "logs",
        );
      },
    ),
    // Not in sprites.dev/api or docs.sprites.dev; the Sprite's local socket, verified live.
    signal: method(
      "Send a signal to this service's process",
      z.object({ signal: z.string().min(1).max(32) }),
      null,
      async (args, ctx: ServiceContext) => {
        await boundSprite(ctx, "service");
        await send(ctx, ctx.globalArgs.sprite, {
          method: "POST",
          path: "/v1/services/signal",
          body: { name: ctx.globalArgs.service_name, signal: args.signal },
          statuses: [204],
        }, execute);
      },
    ),
    delete: method(
      "Delete this service; an already absent service succeeds",
      Empty,
      null,
      async (_args, ctx: ServiceContext) => {
        await boundSprite(ctx, "service");
        try {
          await emptyRequest(ctx, "DELETE", path(ctx));
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        await ctx.deleteResource("service");
      },
    ),
  };
}

/** One service on one Sprite. Bind it with put or get; every other method refuses a replaced Sprite. */
export const model = {
  type: "@josh/sprites/service",
  version: "2026.09.11.1",
  globalArguments: ServiceArgsSchema,
  resources: {
    service: resource(
      ServiceRecord,
      "This service's definition, last known status, and the Sprite it belongs to",
    ),
    put: resource(ServiceEvents, "Create or update progress", "7d"),
    started: resource(ServiceEvents, "Start progress", "7d"),
    stopped: resource(ServiceEvents, "Stop progress", "7d"),
    restarted: resource(ServiceEvents, "Restart progress", "7d"),
    logs: resource(ServiceEvents, "Log stream", "7d"),
  },
  methods: createMethods(),
};
