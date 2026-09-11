// SPDX-License-Identifier: MIT
/** Sprite service protocol schemas and streaming. @module */
import { z } from "npm:zod@4.4.3";
import { type Context, Environment, ndjson, requireComplete } from "./core.ts";

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
export const Services = z.object({ services: z.array(Service) });
export const ServiceEvents = z.object({
  events: z.array(ServiceEvent),
  truncated: z.boolean().describe(
    "True for service log reads, which observe a bounded portion of logs; false for completed operation progress, including operations with a duration.",
  ),
});

export async function serviceStream(
  ctx: Context,
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
  return { events: requireComplete(events, path), truncated: kind === "logs" };
}
