// SPDX-License-Identifier: MIT
/** Bounded listening-port snapshots and notifications. @module */
import { z } from "npm:zod@4.4.3";
import { decodeFrame } from "./core.ts";
import { type ConnectChannel, observeChannel, openChannel } from "./socket.ts";
import { type SpriteContext } from "./sprite.ts";

const MAX_PORTS = 100_000;

const PortNotification = z.object({
  type: z.enum(["port_opened", "port_closed"]),
  port: z.number().int().min(1).max(65_535),
  address: z.string(),
  pid: z.number().int(),
});
const PortList = z.object({
  type: z.literal("port_list"),
  ports: z.array(PortNotification).max(MAX_PORTS).nullable().describe(
    "Current listening ports. The native Go endpoint may encode an empty slice as null.",
  ),
});
export const PortWatchOutput = z.object({
  initialPorts: z.array(PortNotification).max(MAX_PORTS).describe(
    "Initial listening-port snapshot; a native null snapshot is normalized to an empty array.",
  ),
  notifications: z.array(PortNotification).max(MAX_PORTS),
  truncated: z.literal(true).describe(
    "True because observation ends at durationMs or maxEvents, not at an exhaustive event boundary.",
  ),
});
export const PortWatchArgs = z.object({
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxEvents: z.number().int().positive().max(MAX_PORTS).default(1_000).describe(
    "Maximum incremental notifications; initial snapshot entries do not count toward this limit.",
  ),
});
export async function watchPorts(
  ctx: SpriteContext,
  args: z.output<typeof PortWatchArgs>,
  connect: ConnectChannel = openChannel,
): Promise<z.output<typeof PortWatchOutput>> {
  const result = await observeChannel(ctx, {
    connect,
    path: "/ports/watch",
    first: (bytes) =>
      decodeFrame(
        bytes,
        PortList,
        "Sprite port watch returned an invalid initial snapshot frame.",
      ),
    eventSchema: PortNotification,
    event: (value) => value,
    operation: "Sprite port watch",
    cap: args.maxEvents,
    durationMs: args.durationMs,
  });
  return {
    initialPorts: result.first.ports ?? [],
    notifications: result.events,
    truncated: true,
  };
}
