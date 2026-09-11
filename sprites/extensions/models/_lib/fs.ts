// SPDX-License-Identifier: MIT
/** Native filesystem routes and bounded filesystem watch. @module */
import { z } from "zod";
import {
  BinaryFile,
  decodeFrame,
  Input,
  inputBytes,
  jsonRequest,
  method,
  request,
  resource,
  responseBytes,
  sanitize,
  withHandles,
} from "./core.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite.ts";
import { type ConnectChannel, observeChannel, openChannel } from "./socket.ts";

const WorkingDir = z.object({
  workingDir: z.string().min(1).default("/"),
});
const WorkingPath = WorkingDir.extend({ path: z.string().min(1) });
const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  size: z.number().int(),
  mode: z.string(),
  modTime: z.iso.datetime({ offset: true }),
  isDir: z.boolean(),
});
const FsList = z.object({
  path: z.string(),
  entries: z.array(FsEntry),
  count: z.number().int().nonnegative(),
});
const FsWrite = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mode: z.string(),
});
const FsDelete = z.object({
  deleted: z.array(z.string()),
  count: z.number().int().nonnegative(),
});
const FsCopy = z.object({
  copied: z.array(z.object({ source: z.string(), dest: z.string() })),
  count: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
const FsRename = z.object({ source: z.string(), dest: z.string() });
const FsChmod = z.object({
  affected: z.array(z.object({ path: z.string(), mode: z.string() })),
  count: z.number().int().nonnegative(),
});
const FsChown = z.object({
  affected: z.array(
    z.object({
      path: z.string(),
      uid: z.number().int(),
      gid: z.number().int(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
const CommonMutation = z.object({
  recursive: z.boolean().default(false),
  asRoot: z.boolean().default(false),
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
const WatchOutput = z.object({
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

function fsPath(ctx: SpriteContext, operation: string): string {
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

export const fsResources = {
  listFiles: resource(FsList, "Native filesystem directory listing"),
  writeFile: resource(FsWrite, "Native filesystem write result"),
  deleteFile: resource(FsDelete, "Native filesystem deletion result"),
  copyFile: resource(FsCopy, "Native filesystem copy result"),
  renameFile: resource(FsRename, "Native filesystem rename result"),
  chmodFile: resource(FsChmod, "Native filesystem chmod result"),
  chownFile: resource(FsChown, "Native filesystem chown result"),
  watch: resource(
    WatchOutput,
    "Bounded filesystem watch events; never an exhaustive history",
    "7d",
  ),
};

export const fsFiles = { readFile: BinaryFile };

export const fsMethods = {
  listFiles: method(
    "List a Sprite directory",
    WorkingPath.extend({
      recursive: z.boolean().optional(),
      pattern: z.string().optional(),
    }),
    "listFiles",
    FsList,
    (args, ctx: SpriteContext) =>
      jsonRequest(ctx, "GET", fsPath(ctx, "list"), FsList, {
        query: args,
      }),
  ),
  readFile: method(
    "Read raw bytes from a Sprite file",
    WorkingPath,
    null,
    async (args, ctx: SpriteContext) => {
      const response = await request(ctx, "GET", fsPath(ctx, "read"), {
        query: args,
      });
      const bytes = await responseBytes(
        response,
        ctx.globalArgs.maxResponseBytes,
      );
      const handle = await ctx.createFileWriter("readFile", "readFile")
        .writeAll(bytes);
      ctx.logger.info("Read Sprite file", { bytes: bytes.length });
      return withHandles(undefined, [handle]);
    },
  ),
  writeFile: method(
    "Write raw bytes to a Sprite file",
    WorkingPath.extend({
      content: Input.meta({ sensitive: true }),
      mode: z.string().regex(/^[0-7]{3,4}$/).optional(),
      // The live OpenAPI calls this query parameter mkdir; older SDKs used mkdirParents.
      mkdir: z.boolean().optional(),
    }),
    "writeFile",
    FsWrite,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "PUT", fsPath(ctx, "write"), FsWrite, {
        query: {
          path: args.path,
          workingDir: args.workingDir,
          mode: args.mode,
          mkdir: args.mkdir,
        },
        bytes: inputBytes(args.content),
        headers: { "content-type": "application/octet-stream" },
      });
    },
  ),
  deleteFile: method(
    "Delete a Sprite file or directory",
    WorkingPath.merge(CommonMutation),
    "deleteFile",
    FsDelete,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "DELETE", fsPath(ctx, "delete"), FsDelete, {
        json: args,
      });
    },
  ),
  copyFile: method(
    "Copy a Sprite file or directory",
    z.object({
      source: z.string().min(1),
      dest: z.string().min(1),
      preserveAttrs: z.boolean().default(false),
    }).extend(WorkingDir.shape).merge(CommonMutation),
    "copyFile",
    FsCopy,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "POST", fsPath(ctx, "copy"), FsCopy, {
        json: args,
      });
    },
  ),
  renameFile: method(
    "Rename a Sprite file or directory",
    z.object({
      source: z.string().min(1),
      dest: z.string().min(1),
    }).extend(WorkingDir.shape).extend(
      CommonMutation.omit({ recursive: true }).shape,
    ),
    "renameFile",
    FsRename,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "POST", fsPath(ctx, "rename"), FsRename, {
        json: args,
      });
    },
  ),
  chmodFile: method(
    "Change Sprite file permissions",
    WorkingPath.merge(CommonMutation).extend({
      mode: z.string().regex(/^[0-7]{3,4}$/),
    }),
    "chmodFile",
    FsChmod,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "POST", fsPath(ctx, "chmod"), FsChmod, {
        json: args,
      });
    },
  ),
  chownFile: method(
    "Change Sprite file ownership",
    WorkingPath.merge(CommonMutation).extend({
      uid: z.number().int().nonnegative().optional(),
      gid: z.number().int().nonnegative().optional(),
    }).refine((value) => value.uid !== undefined || value.gid !== undefined, {
      message: "Provide uid or gid.",
    }),
    "chownFile",
    FsChown,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "POST", fsPath(ctx, "chown"), FsChown, {
        json: args,
      });
    },
  ),
  watch: method(
    "Observe acknowledged Sprite filesystem events for a bounded duration",
    WatchArgs,
    "watch",
    WatchOutput,
    (args, ctx: SpriteContext) => observeWatch(ctx, args),
  ),
};
