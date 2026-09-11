// SPDX-License-Identifier: MIT
/** Sprite service configuration, lifecycle, and logs. @module */
import { z } from "zod";
import {
  Empty,
  emptyRequest,
  Environment,
  jsonRequest,
  method,
  ndjson,
  requireComplete,
  resource,
  segment,
} from "./core.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite.ts";

const ServiceState = z.object({
  name: z.string(),
  status: z.enum(["stopped", "starting", "running", "stopping", "failed"]),
  pid: z.number().int().optional(),
  started_at: z.string().optional(),
  error: z.string().optional(),
  restart_count: z.number().int().nonnegative().optional(),
  next_restart_at: z.string().optional(),
});
export const Service = z.object({
  name: z.string(),
  cmd: z.string(),
  args: z.array(z.string()).nullable(),
  env: Environment.optional(),
  dir: z.string().optional(),
  needs: z.array(z.string()).nullable(),
  http_port: z.number().int().nullable().optional(),
  state: ServiceState.nullish(),
});
const Timestamp = z.number().int();
const ServiceEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdout"),
    data: z.string().meta({ sensitive: true }),
    timestamp: Timestamp,
  }),
  z.object({
    type: z.literal("stderr"),
    data: z.string().meta({ sensitive: true }),
    timestamp: Timestamp,
  }),
  z.object({
    type: z.literal("error"),
    data: z.string().meta({ sensitive: true }),
    timestamp: Timestamp,
  }),
  z.object({
    type: z.literal("exit"),
    exit_code: z.number().int(),
    timestamp: Timestamp,
  }),
  z.object({ type: z.literal("started"), timestamp: Timestamp }),
  z.object({ type: z.literal("stopping"), timestamp: Timestamp }),
  z.object({
    type: z.literal("stopped"),
    exit_code: z.number().int(),
    timestamp: Timestamp,
  }),
  z.object({
    type: z.literal("complete"),
    timestamp: Timestamp,
    log_files: z.record(z.string(), z.string()).optional(),
  }),
]);
const Services = z.object({
  services: z.array(Service),
});
const ServiceEvents = z.object({
  events: z.array(ServiceEvent),
  truncated: z.boolean().describe(
    "True for service log reads, which observe a bounded portion of logs; false for completed operation progress, including operations with a duration.",
  ),
});

function servicePath(ctx: SpriteContext, name: string, suffix = ""): string {
  return spritePath(ctx, `/services/${segment(name)}${suffix}`);
}
async function serviceStream(
  ctx: SpriteContext,
  methodName: string,
  path: string,
  options: NonNullable<Parameters<typeof ndjson>[4]>,
  kind: "startup" | "logs" | "progress",
): Promise<z.input<typeof ServiceEvents>> {
  const events = await ndjson(ctx, methodName, path, ServiceEvent, options);
  if (kind === "startup") {
    const exited = events.find(
      (
        event,
      ): event is Extract<z.output<typeof ServiceEvent>, { type: "exit" }> =>
        event.type === "exit",
    );
    if (exited) {
      throw new Error(
        `Sprite service exited during startup with code ${exited.exit_code}; inspect its service logs before retrying.`,
      );
    }
  }
  return {
    events: requireComplete(events, path),
    truncated: kind === "logs",
  };
}

export const servicesResources = {
  services: resource(Services, "Configured Sprite services"),
  service: resource(Service, "One configured Sprite service"),
  servicePut: resource(
    ServiceEvents,
    "Service create or update progress",
    "7d",
  ),
  serviceLogs: resource(ServiceEvents, "Service log stream", "7d"),
  serviceStarted: resource(ServiceEvents, "Service start progress", "7d"),
  serviceStopped: resource(ServiceEvents, "Service stop progress", "7d"),
  serviceRestarted: resource(ServiceEvents, "Service restart progress", "7d"),
};

export const servicesMethods = {
  listServices: method(
    "List configured Sprite services",
    Empty,
    "services",
    Services,
    async (_args, ctx: SpriteContext) => ({
      services: await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx, "/services"),
        z.array(Service),
      ),
    }),
  ),
  putService: method(
    "Create or update a Sprite service",
    z.object({
      service_name: z.string().min(1),
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
    "servicePut",
    ServiceEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await serviceStream(
        ctx,
        "PUT",
        servicePath(ctx, args.service_name),
        { query: { duration: args.duration }, json: args.service },
        "startup",
      );
    },
  ),
  getServiceLogs: method(
    "Read a Sprite service log stream",
    z.object({
      service_name: z.string().min(1),
      lines: z.number().int().nonnegative().optional(),
      duration: z.string().min(1).optional(),
    }),
    "serviceLogs",
    ServiceEvents,
    (args, ctx: SpriteContext) =>
      serviceStream(
        ctx,
        "GET",
        servicePath(ctx, args.service_name, "/logs"),
        { query: { lines: args.lines, duration: args.duration } },
        "logs",
      ),
  ),
  startService: method(
    "Start a Sprite service",
    z.object({
      service_name: z.string().min(1),
      duration: z.string().min(1).optional(),
    }),
    "serviceStarted",
    ServiceEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await serviceStream(
        ctx,
        "POST",
        servicePath(ctx, args.service_name, "/start"),
        { query: { duration: args.duration } },
        "startup",
      );
    },
  ),
  stopService: method(
    "Stop a Sprite service",
    z.object({
      service_name: z.string().min(1),
      timeout: z.string().min(1).optional(),
    }),
    "serviceStopped",
    ServiceEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await serviceStream(
        ctx,
        "POST",
        servicePath(ctx, args.service_name, "/stop"),
        { query: { timeout: args.timeout } },
        "progress",
      );
    },
  ),
  restartService: method(
    "Restart a Sprite service",
    z.object({
      service_name: z.string().min(1),
      duration: z.string().min(1).optional(),
    }),
    "serviceRestarted",
    ServiceEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await serviceStream(
        ctx,
        "POST",
        servicePath(ctx, args.service_name, "/restart"),
        { query: { duration: args.duration } },
        "startup",
      );
    },
  ),
  deleteService: method(
    "Delete a Sprite service",
    z.object({ service_name: z.string().min(1) }),
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(ctx, "DELETE", servicePath(ctx, args.service_name));
    },
  ),
};
