// SPDX-License-Identifier: MIT
/** Typed JSON, binary, and NDJSON methods for one Sprite. @module */
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  ApiError,
  BinaryFile,
  deadline,
  emptyRequest,
  Input,
  inputBytes,
  jsonRequest,
  method,
  ndjson,
  request,
  resource,
  responseBytes,
  segment,
  withHandles,
} from "./core.ts";
import {
  type SpriteContext,
  spritePath,
  SpriteResponse,
  verifySprite,
} from "./sprite-api.ts";

const Empty = z.object({});
const UrlProbe = z.object({
  bodyBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const CheckpointId = z.string().min(1);
const Environment = z.record(z.string(), z.string()).meta({ sensitive: true });
const RequestUrlSettings = z.object({
  auth: z.enum(["sprite", "public"]).optional(),
  private_access: z.enum(["admins", "org_users"]).optional(),
});
const SpriteConfig = z.object({
  ram_mb: z.number().positive().optional(),
  cpus: z.number().positive().optional(),
  region: z.string().min(1).optional(),
  storage_gb: z.number().positive().optional(),
});
const CreateArgs = z.object({
  config: SpriteConfig.optional(),
  environment: Environment.optional(),
  url_settings: RequestUrlSettings.optional(),
  labels: z.array(z.string()).optional(),
  wait_for_capacity: z.boolean().optional(),
  runtime: z.enum(["default", "dev"]).optional(),
});
const UpdateArgs = z.object({
  url_settings: RequestUrlSettings.optional(),
  labels: z.array(z.string()).optional(),
}).refine(
  (value) => value.url_settings !== undefined || value.labels !== undefined,
  {
    message: "Provide url_settings or labels.",
  },
);

const Checkpoint = z.object({
  id: z.string(),
  create_time: z.iso.datetime({ offset: true }),
  comment: z.string().optional(),
  health: z.string().optional(),
  source_id: z.string().optional(),
});
const CheckpointEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("info"),
    data: z.string(),
    time: z.iso.datetime({ offset: true }),
  }),
  z.object({
    type: z.literal("complete"),
    data: z.string(),
    time: z.iso.datetime({ offset: true }),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
    time: z.iso.datetime({ offset: true }),
  }),
]);
const CheckpointEvents = z.object({
  events: z.array(CheckpointEvent),
});
const Checkpoints = z.object({
  checkpoints: z.array(Checkpoint),
});

const NetworkRule = z.object({
  domain: z.string().optional(),
  action: z.enum(["allow", "deny"]).optional(),
  include: z.string().optional(),
}).refine(
  (rule) => !(rule.domain !== undefined && rule.include !== undefined),
  {
    message: "A network rule cannot contain both domain and include.",
  },
);
const NetworkPolicy = z.object({ rules: z.array(NetworkRule) });
const PrivilegesPolicy = z.object({
  profile: z.enum(["", "minimal", "standard", "privileged"]).optional(),
  devices: z.array(z.string()).optional(),
  noNewPrivileges: z.boolean().optional(),
});
const ResourcesPolicy = z.object({
  memory: z.object({
    limit_mb: z.number().positive(),
    autoscale: z.boolean().optional(),
  }).optional(),
});

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
const ServiceRequest = z.object({
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: Environment.optional(),
  dir: z.string().optional(),
  needs: z.array(z.string()).default([]),
  http_port: z.number().int().nullable().optional(),
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

function checkpointPath(ctx: SpriteContext, id: string): string {
  return spritePath(ctx, `/checkpoints/${segment(id)}`);
}
function servicePath(ctx: SpriteContext, name: string, suffix = ""): string {
  return spritePath(ctx, `/services/${segment(name)}${suffix}`);
}
function fsPath(ctx: SpriteContext, operation: string): string {
  return spritePath(ctx, `/fs/${operation}`);
}
function requireComplete<T extends { type: string }>(
  events: T[],
  operation: string,
): T[] {
  if (!events.some((event) => event.type === "complete")) {
    throw new Error(
      `Sprites ${operation} progress ended without a complete event; no output was saved.`,
    );
  }
  return events;
}
async function checkpointStream(
  ctx: SpriteContext,
  path: string,
  json?: unknown,
): Promise<z.input<typeof CheckpointEvents>> {
  const events = await ndjson(
    ctx,
    "POST",
    path,
    CheckpointEvent,
    { json },
  );
  return { events: requireComplete(events, path) };
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
/** JSON resources emitted by REST methods. Provider field names remain unchanged. */
export const restResources = {
  state: resource(SpriteResponse, "Current provider metadata for this Sprite"),
  urlProbe: resource(
    UrlProbe,
    "Authenticated root URL response fingerprint; not a general application health guarantee",
    "7d",
  ),
  checkpointCreated: resource(CheckpointEvents, "Checkpoint creation progress"),
  checkpoints: resource(Checkpoints, "Sprite checkpoints"),
  checkpoint: resource(Checkpoint, "One Sprite checkpoint"),
  checkpointRestored: resource(
    CheckpointEvents,
    "Checkpoint restoration progress",
  ),
  networkPolicy: resource(NetworkPolicy, "Sprite network policy"),
  privilegesPolicy: resource(PrivilegesPolicy, "Sprite privilege policy"),
  resourcesPolicy: resource(ResourcesPolicy, "Sprite resource policy"),
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
  files: resource(FsList, "Native filesystem directory listing"),
  fileWritten: resource(FsWrite, "Native filesystem write result"),
  fileDeleted: resource(FsDelete, "Native filesystem deletion result"),
  fileCopied: resource(FsCopy, "Native filesystem copy result"),
  fileRenamed: resource(FsRename, "Native filesystem rename result"),
  fileModeChanged: resource(FsChmod, "Native filesystem chmod result"),
  fileOwnerChanged: resource(FsChown, "Native filesystem chown result"),
};

/** Binary outputs emitted by REST methods. */
export const restFiles = { contents: BinaryFile };

/** Complete non-WebSocket REST method set for one Sprite. */
export const restMethods = {
  create: method(
    "Create the configured Sprite",
    CreateArgs,
    "state",
    SpriteResponse,
    async (args, ctx: SpriteContext) =>
      await jsonRequest(ctx, "POST", "/v1/sprites", SpriteResponse, {
        json: { name: ctx.globalArgs.name, ...args },
      }),
  ),
  lookup: method(
    "Read the configured Sprite",
    Empty,
    "state",
    SpriteResponse,
    async (_args, ctx: SpriteContext) =>
      await jsonRequest(ctx, "GET", spritePath(ctx), SpriteResponse),
  ),
  update: method(
    "Update the configured Sprite",
    UpdateArgs,
    "state",
    SpriteResponse,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "PUT", spritePath(ctx), SpriteResponse, {
        json: args,
      });
    },
  ),
  upgrade: method(
    "Request a runtime upgrade; success only acknowledges provider acceptance",
    z.object({ version: z.string().min(1).optional() }),
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "POST",
        spritePath(ctx, "/upgrade"),
        args.version === undefined ? {} : { json: { version: args.version } },
      );
    },
  ),
  restart: method(
    "Request a restart of the machine backing this Sprite",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(ctx, "POST", spritePath(ctx, "/restart"));
    },
  ),
  probeUrl: method(
    "Check the verified Sprite root URL and fingerprint its response",
    Empty,
    "urlProbe",
    UrlProbe,
    async (_args, ctx: SpriteContext) => {
      const operation = deadline(ctx);
      const { signal } = operation;
      try {
        const state = await verifySprite({ ...ctx, signal });
        const url = new URL(state.url);
        if (
          url.protocol !== "https:" || !url.hostname.endsWith(".sprites.app") ||
          !url.hostname.startsWith(`${ctx.globalArgs.name}-`) || url.username ||
          url.password || url.port || url.pathname !== "/" || url.search ||
          url.hash
        ) {
          throw new Error(
            "Sprite URL is not an expected provider-owned root URL; no credential was sent to it.",
          );
        }
        const response = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${ctx.globalArgs.token}` },
          redirect: "error",
          signal,
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`Sprite URL probe returned HTTP ${response.status}.`);
        }
        const bytes = await responseBytes(
          response,
          ctx.globalArgs.maxResponseBytes,
        );
        const digest = createHash("sha256").update(bytes).digest("hex");
        return {
          bodyBytes: bytes.length,
          sha256: digest,
        };
      } finally {
        operation.dispose();
      }
    },
  ),
  delete: method(
    "Delete the configured Sprite",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      try {
        await verifySprite(ctx);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
        await ctx.deleteResource("state");
        return;
      }
      try {
        await emptyRequest(ctx, "DELETE", spritePath(ctx));
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      await ctx.deleteResource("state");
    },
  ),

  createCheckpoint: method(
    "Create a Sprite checkpoint",
    z.object({ comment: z.string().optional() }),
    "checkpointCreated",
    CheckpointEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await checkpointStream(
        ctx,
        spritePath(ctx, "/checkpoint"),
        args,
      );
    },
  ),
  listCheckpoints: method(
    "List Sprite checkpoints",
    Empty,
    "checkpoints",
    Checkpoints,
    async (_args, ctx: SpriteContext) => ({
      checkpoints: await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx, "/checkpoints"),
        z.array(Checkpoint),
      ),
    }),
  ),
  getCheckpoint: method(
    "Read a Sprite checkpoint",
    z.object({ checkpoint_id: CheckpointId }),
    "checkpoint",
    Checkpoint,
    async (args, ctx: SpriteContext) =>
      await jsonRequest(
        ctx,
        "GET",
        checkpointPath(ctx, args.checkpoint_id),
        Checkpoint,
      ),
  ),
  restoreCheckpoint: method(
    "Restore a Sprite checkpoint",
    z.object({ checkpoint_id: CheckpointId }),
    "checkpointRestored",
    CheckpointEvents,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await checkpointStream(
        ctx,
        `${checkpointPath(ctx, args.checkpoint_id)}/restore`,
      );
    },
  ),

  getNetworkPolicy: method(
    "Read the Sprite network policy",
    Empty,
    "networkPolicy",
    NetworkPolicy,
    async (_args, ctx: SpriteContext) =>
      await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx, "/policy/network"),
        NetworkPolicy,
      ),
  ),
  setNetworkPolicy: method(
    "Replace the Sprite network policy",
    NetworkPolicy,
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(ctx, "POST", spritePath(ctx, "/policy/network"), {
        json: args,
      });
    },
  ),
  getPrivilegesPolicy: method(
    "Read the Sprite privilege policy",
    Empty,
    "privilegesPolicy",
    PrivilegesPolicy,
    async (_args, ctx: SpriteContext) =>
      await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx, "/policy/privileges"),
        PrivilegesPolicy,
      ),
  ),
  setPrivilegesPolicy: method(
    "Set the Sprite privilege policy",
    PrivilegesPolicy,
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(ctx, "POST", spritePath(ctx, "/policy/privileges"), {
        json: args,
      });
    },
  ),
  deletePrivilegesPolicy: method(
    "Remove the Sprite privilege policy",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(ctx, "DELETE", spritePath(ctx, "/policy/privileges"));
    },
  ),
  getResourcesPolicy: method(
    "Read the Sprite resource policy",
    Empty,
    "resourcesPolicy",
    ResourcesPolicy,
    async (_args, ctx: SpriteContext) =>
      await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx, "/policy/resources"),
        ResourcesPolicy,
      ),
  ),
  setResourcesPolicy: method(
    "Set the Sprite resource policy",
    ResourcesPolicy,
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(ctx, "POST", spritePath(ctx, "/policy/resources"), {
        json: args,
      });
    },
  ),
  deleteResourcesPolicy: method(
    "Remove the Sprite resource policy",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(ctx, "DELETE", spritePath(ctx, "/policy/resources"));
    },
  ),

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
      service: ServiceRequest,
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
    async (args, ctx: SpriteContext) =>
      await serviceStream(
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

  listFiles: method(
    "List a Sprite directory",
    WorkingPath.extend({
      recursive: z.boolean().optional(),
      pattern: z.string().optional(),
    }),
    "files",
    FsList,
    async (args, ctx: SpriteContext) =>
      await jsonRequest(ctx, "GET", fsPath(ctx, "list"), FsList, {
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
      const handle = await ctx.createFileWriter("contents", "contents")
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
    "fileWritten",
    FsWrite,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      const bytes = inputBytes(args.content);
      return await jsonRequest(ctx, "PUT", fsPath(ctx, "write"), FsWrite, {
        query: {
          path: args.path,
          workingDir: args.workingDir,
          mode: args.mode,
          mkdir: args.mkdir,
        },
        bytes,
        headers: { "content-type": "application/octet-stream" },
      });
    },
  ),
  deleteFile: method(
    "Delete a Sprite file or directory",
    WorkingPath.merge(CommonMutation),
    "fileDeleted",
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
    "fileCopied",
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
    "fileRenamed",
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
    "fileModeChanged",
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
    "fileOwnerChanged",
    FsChown,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await jsonRequest(ctx, "POST", fsPath(ctx, "chown"), FsChown, {
        json: args,
      });
    },
  ),
};
