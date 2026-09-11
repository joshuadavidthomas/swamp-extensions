// SPDX-License-Identifier: MIT
/** One service on a Sprite: its definition, lifecycle, logs, and signal. @module */
import { z } from "npm:zod@4.4.3";
import {
  ApiError,
  type Context,
  emptyRequest,
  jsonRequest,
  runMethod,
  segment,
  withHandles,
} from "./_lib/core.ts";
import { executeHttp } from "./_lib/exec.ts";
import { type ManagementExec, send } from "./_lib/local-api.ts";
import { Service, ServiceEvents, serviceStream } from "./_lib/services.ts";
import {
  bindSprite,
  boundSprite,
  SpriteIdentity,
  spritePath,
} from "./_lib/sprite.ts";

const ServiceArgsSchema = z.object({
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
  service_name: z.string().min(1).describe("Service name on that Sprite."),
});
type ServiceContext = Context<z.output<typeof ServiceArgsSchema>> & {
  managementExec?: ManagementExec;
};
function methodDescription(name: string): string {
  const methods: Record<string, { description: string }> = model.methods;
  return methods[name].description;
}
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

/** Send a service signal through an injectable local management transport. */
async function sendServiceSignal(
  args: { signal: string },
  ctx: ServiceContext,
  execute: ManagementExec,
): Promise<void> {
  await boundSprite(ctx);
  await send(ctx, ctx.globalArgs.sprite, {
    method: "POST",
    path: "/v1/services/signal",
    body: { name: ctx.globalArgs.service_name, signal: args.signal },
    statuses: [204],
  }, execute);
}

/** One service on one Sprite. Bind it with put or get; every other method refuses a replaced Sprite. */
export const model = {
  type: "@josh/sprites/service",
  version: "2026.09.11.1",
  globalArguments: ServiceArgsSchema,
  resources: {
    state: {
      schema: ServiceRecord,
      description:
        "This service's definition, last known status, and the Sprite it belongs to",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    put: {
      schema: ServiceEvents,
      description: "Create or update progress",
      lifetime: "7d",
      garbageCollection: 10,
    },
    start: {
      schema: ServiceEvents,
      description: "Start progress",
      lifetime: "7d",
      garbageCollection: 10,
    },
    stop: {
      schema: ServiceEvents,
      description: "Stop progress",
      lifetime: "7d",
      garbageCollection: 10,
    },
    restart: {
      schema: ServiceEvents,
      description: "Restart progress",
      lifetime: "7d",
      garbageCollection: 10,
    },
    logs: {
      schema: ServiceEvents,
      description: "Log stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    put: {
      description: "Create or update this service, then save its definition",
      arguments: z.object({
        service: z.object({
          cmd: z.string().min(1),
          args: z.array(z.string()).optional().default([]),
          env: z.record(z.string(), z.string()).optional().meta({
            sensitive: true,
          }),
          dir: z.string().optional(),
          needs: z.array(z.string()).optional().default([]),
          http_port: z.number().int().nullable().optional(),
        }),
        duration: z.string().min(1).optional(),
      }),
      execute: (
        args: {
          service: {
            cmd: string;
            args: string[];
            env?: Record<string, string>;
            dir?: string;
            needs: string[];
            http_port?: number | null;
          };
          duration?: string;
        },
        ctx: ServiceContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("put"),
          "state",
          ServiceRecord,
          async () => {
            const sprite = await bindSprite(ctx);
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
    },
    get: {
      description: "Read this service and save it",
      arguments: z.object({}),
      execute: (_args: object, ctx: ServiceContext) =>
        runMethod(
          ctx,
          methodDescription("get"),
          "state",
          ServiceRecord,
          async () => record(ctx, await bindSprite(ctx)),
        ),
    },
    start: {
      description: "Start this service",
      arguments: z.object({ duration: z.string().min(1).optional() }),
      execute: (args: { duration?: string }, ctx: ServiceContext) =>
        runMethod(
          ctx,
          methodDescription("start"),
          "start",
          ServiceEvents,
          async () => {
            await boundSprite(ctx);
            return await serviceStream(
              ctx,
              "POST",
              path(ctx, "/start"),
              { query: { duration: args.duration } },
              "startup",
            );
          },
        ),
    },
    stop: {
      description: "Stop this service",
      arguments: z.object({ timeout: z.string().min(1).optional() }),
      execute: (args: { timeout?: string }, ctx: ServiceContext) =>
        runMethod(
          ctx,
          methodDescription("stop"),
          "stop",
          ServiceEvents,
          async () => {
            await boundSprite(ctx);
            return await serviceStream(
              ctx,
              "POST",
              path(ctx, "/stop"),
              { query: { timeout: args.timeout } },
              "progress",
            );
          },
        ),
    },
    restart: {
      description: "Restart this service",
      arguments: z.object({ duration: z.string().min(1).optional() }),
      execute: (args: { duration?: string }, ctx: ServiceContext) =>
        runMethod(
          ctx,
          methodDescription("restart"),
          "restart",
          ServiceEvents,
          async () => {
            await boundSprite(ctx);
            return await serviceStream(
              ctx,
              "POST",
              path(ctx, "/restart"),
              { query: { duration: args.duration } },
              "startup",
            );
          },
        ),
    },
    logs: {
      description: "Read a bounded portion of this service's log stream",
      arguments: z.object({
        lines: z.number().int().nonnegative().optional(),
        duration: z.string().min(1).optional(),
      }),
      execute: (
        args: { lines?: number; duration?: string },
        ctx: ServiceContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("logs"),
          "logs",
          ServiceEvents,
          async () => {
            await boundSprite(ctx);
            return await serviceStream(
              ctx,
              "GET",
              path(ctx, "/logs"),
              { query: { lines: args.lines, duration: args.duration } },
              "logs",
            );
          },
        ),
    },
    signal: {
      description: "Send a signal to this service's process",
      arguments: z.object({ signal: z.string().min(1).max(32) }),
      execute: (args: { signal: string }, ctx: ServiceContext) =>
        runMethod(
          ctx,
          methodDescription("signal"),
          null,
          () => sendServiceSignal(args, ctx, ctx.managementExec ?? executeHttp),
        ),
    },
    delete: {
      description: "Delete this service; an already absent service succeeds",
      arguments: z.object({}),
      execute: (_args: object, ctx: ServiceContext) =>
        runMethod(ctx, methodDescription("delete"), null, async () => {
          await boundSprite(ctx);
          try {
            await emptyRequest(ctx, "DELETE", path(ctx));
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) {
              throw error;
            }
          }
          await ctx.deleteResource("state");
        }),
    },
  },
};
