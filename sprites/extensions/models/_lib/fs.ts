// SPDX-License-Identifier: MIT
/** Native filesystem routes and bounded filesystem watch. @module */
import { z } from "npm:zod@4.4.3";
import { decodeFrame, sanitize } from "./core.ts";
import { type SpriteContext, spritePath } from "./sprite.ts";
import { type ConnectChannel, observeChannel, openChannel } from "./socket.ts";

const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  size: z.number().int(),
  mode: z.string(),
  modTime: z.iso.datetime({ offset: true }),
  isDir: z.boolean(),
});
export const FsList = z.object({
  path: z.string(),
  entries: z.array(FsEntry),
  count: z.number().int().nonnegative(),
});
export const FsWrite = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mode: z.string(),
});
export const FsDelete = z.object({
  deleted: z.array(z.string()),
  count: z.number().int().nonnegative(),
});
export const FsCopy = z.object({
  copied: z.array(z.object({ source: z.string(), dest: z.string() })),
  count: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export const FsRename = z.object({ source: z.string(), dest: z.string() });
export const FsChmod = z.object({
  affected: z.array(z.object({ path: z.string(), mode: z.string() })),
  count: z.number().int().nonnegative(),
});
export const FsChown = z.object({
  affected: z.array(
    z.object({
      path: z.string(),
      uid: z.number().int(),
      gid: z.number().int(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
const WatchEvent = z.object({
  type: z.literal("event"),
  path: z.string().optional(),
  event: z.enum(["write", "create", "remove", "rename", "chmod"]).optional(),
  timestamp: z.string().optional(),
  size: z.number().optional(),
  isDir: z.boolean().optional(),
});
const WatchMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribed"),
    paths: z.array(z.string()).optional(),
  }),
  WatchEvent,
  z.object({
    type: z.literal("error"),
    message: z.string().optional(),
  }),
]);
export const WatchOutput = z.object({
  events: z.array(WatchEvent),
  truncated: z.literal(true).describe(
    "True because observation ends at durationMs or maxEvents, not at an exhaustive filesystem boundary.",
  ),
});

export const WatchArgs = z.object({
  paths: z.array(z.string()).min(1),
  recursive: z.boolean().default(false),
  workingDir: z.string().min(1).default("/"),
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxEvents: z.number().int().positive().max(100_000).default(1_000),
});

export function fsPath(ctx: SpriteContext, operation: string): string {
  return spritePath(ctx.globalArgs.name, `/fs/${operation}`);
}
function watchError(message: string | undefined, token: string): Error {
  const reason = message === undefined
    ? undefined
    : sanitize(message, token, 512);
  return new Error(
    `Filesystem watch reported an error${reason ? `: ${reason}` : "."}`,
  );
}

export async function observeWatch(
  ctx: SpriteContext,
  args: z.output<typeof WatchArgs>,
  connect: ConnectChannel = openChannel,
): Promise<z.output<typeof WatchOutput>> {
  const result = await observeChannel(ctx, {
    connect,
    path: "/fs/watch",
    subscribe: JSON.stringify({
      type: "subscribe",
      paths: args.paths,
      recursive: args.recursive,
      workingDir: args.workingDir,
    }),
    first: (bytes) => {
      const value = decodeFrame(
        bytes,
        WatchMessage,
        "Filesystem watch returned an invalid JSON control frame.",
      );
      if (value.type === "error") {
        throw watchError(value.message, ctx.globalArgs.token);
      }
      if (value.type !== "subscribed") {
        throw new Error(
          "Filesystem watch did not acknowledge its subscription.",
        );
      }
      ctx.logger.info("Filesystem subscription acknowledged");
      return value;
    },
    eventSchema: WatchMessage,
    event: (value) => {
      if (value.type === "error") {
        throw watchError(value.message, ctx.globalArgs.token);
      }
      if (value.type === "subscribed") {
        throw new Error(
          "Filesystem watch returned an unexpected second subscription acknowledgement.",
        );
      }
      return value;
    },
    operation: "Filesystem watch",
    cap: args.maxEvents,
    durationMs: args.durationMs,
  });
  return { events: result.events, truncated: true };
}
