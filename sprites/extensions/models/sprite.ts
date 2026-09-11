// SPDX-License-Identifier: MIT
/** Complete single-Sprite lifecycle, execution, storage, policy, and networking model. @module */
import { createHash } from "node:crypto";
import { z } from "npm:zod@4.4.3";
import {
  ApiError,
  deadline,
  emptyRequest,
  Input,
  inputBytes,
  jsonRequest,
  ndjson,
  request,
  responseBytes,
  runMethod,
  segment,
  withHandles,
} from "./_lib/core.ts";
import { Checkpoint, Checkpoints } from "./_lib/checkpoints.ts";
import {
  ControlExecOperationArgs,
  ControlExecution,
  executeControl,
  saveControlExecution,
} from "./_lib/control.ts";
import {
  AttachArgs as NativeAttachArgs,
  envPairs,
  ExecArgs as NativeExecArgs,
  executeHttp,
  executeSocket,
  Execution,
  Killed,
  KillEvent,
  runSocketExecution,
  saveExecution,
  Sessions,
} from "./_lib/exec.ts";
import {
  FsChmod,
  FsChown,
  FsCopy,
  FsDelete,
  FsList,
  fsPath,
  FsRename,
  FsWrite,
  observeWatch,
  WatchOutput,
} from "./_lib/fs.ts";
import {
  discoverGateway,
  GatewayList,
  GatewayResponse,
  ProviderMethod,
  relayGateway,
  validProviderPath,
} from "./_lib/gateway.ts";
import {
  NetworkPolicy,
  NetworkRule,
  PrivilegesPolicy,
  ResourcesPolicy,
} from "./_lib/policy.ts";
import { PortWatchOutput, watchPorts } from "./_lib/ports.ts";
import { ProxyOutput, runProxy } from "./_lib/proxy.ts";
import { Service, Services } from "./_lib/services.ts";
import {
  type SpriteContext,
  spritePath,
  SpriteResponse,
  UrlProbe,
  verifySprite,
} from "./_lib/sprite.ts";
import { listTasks, Tasks } from "./_lib/tasks.ts";
import { type ManagementExec } from "./_lib/local-api.ts";

type RuntimeSpriteContext = SpriteContext & {
  managementExec?: ManagementExec;
  controlExec?: typeof executeControl;
  socketExec?: typeof executeSocket;
  watch?: typeof observeWatch;
  portWatch?: typeof watchPorts;
  proxy?: typeof runProxy;
  gatewayDiscover?: typeof discoverGateway;
  gatewayRelay?: typeof relayGateway;
};
function methodDescription(name: string): string {
  const methods: Record<string, { description: string }> = model.methods;
  return methods[name].description;
}
const SpriteArgsSchema = z.object({
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
  name: z.string().min(1).describe(
    "Sprite name within the token's organization.",
  ),
});
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
  config: z.object(SpriteConfig.shape).optional(),
  environment: z.record(z.string(), z.string()).optional().meta({
    sensitive: true,
  }),
  url_settings: z.object(RequestUrlSettings.shape).optional(),
  labels: z.array(z.string()).optional(),
  wait_for_capacity: z.boolean().optional(),
  runtime: z.enum(["default", "dev"]).optional(),
});
const UpdateArgs = z.object({
  url_settings: z.object(RequestUrlSettings.shape).optional(),
  labels: z.array(z.string()).optional(),
}).refine(
  (value) => value.url_settings !== undefined || value.labels !== undefined,
  {
    message: "Provide url_settings or labels.",
  },
);
const TimerMs = z.number().int().nonnegative().max(2_147_483_647);
const Action = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdin"),
    atMs: TimerMs,
    input: z.discriminatedUnion("kind", Input.options),
  }),
  z.object({ type: z.literal("eof"), atMs: TimerMs }),
  z.object({
    type: z.literal("resize"),
    atMs: TimerMs,
    rows: z.number().int().min(1).max(65_535),
    cols: z.number().int().min(1).max(65_535),
  }),
  z.object({
    type: z.literal("signal"),
    atMs: TimerMs,
    signal: z.string().min(1),
  }),
]);
const ExecArgs = z.object({
  cmd: z.array(z.string()).min(1).describe(
    "Program and argv, encoded as repeated cmd parameters.",
  ),
  path: z.string().optional(),
  dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional().meta({ sensitive: true }),
  input: z.discriminatedUnion("kind", Input.options).optional().meta({
    sensitive: true,
  }),
  failOnNonZero: z.boolean().optional().default(true),
  tty: z.boolean().optional().default(false),
  rows: z.number().int().min(1).max(65_535).optional(),
  cols: z.number().int().min(1).max(65_535).optional(),
  detachable: z.boolean().optional().default(false),
  cc: z.boolean().optional().default(false),
  max_run_after_disconnect: z.string().optional(),
  closeStdin: z.boolean().optional().default(true),
  actions: z.array(Action).optional().default([]).meta({ sensitive: true }),
  detachAfterMs: z.number().int().positive().max(2_147_483_647).optional()
    .describe(
      "Save session identity and disconnect after this duration instead of waiting for exit.",
    ),
}).refine(
  (args) => args.tty || (args.rows === undefined && args.cols === undefined),
  "Exec rows and cols require a TTY session.",
);
const AttachArgs = z.object({
  session_id: z.string().min(1),
  input: z.discriminatedUnion("kind", Input.options).optional().meta({
    sensitive: true,
  }),
  failOnNonZero: z.boolean().optional().default(true),
  tty: z.boolean().optional().default(false),
  rows: z.number().int().min(1).max(65_535).optional(),
  cols: z.number().int().min(1).max(65_535).optional(),
  detachable: z.boolean().optional().default(false),
  cc: z.boolean().optional().default(false),
  max_run_after_disconnect: z.string().optional(),
  closeStdin: z.boolean().optional().default(true),
  actions: z.array(Action).optional().default([]).meta({ sensitive: true }),
  detachAfterMs: z.number().int().positive().max(2_147_483_647).optional()
    .describe(
      "Save session identity and disconnect after this duration instead of waiting for exit.",
    ),
}).refine(
  (args) => args.tty || (args.rows === undefined && args.cols === undefined),
  "Exec rows and cols require a TTY session.",
);
const HttpExecArgs = z.object({
  cmd: z.array(z.string()).min(1).describe(
    "Program and argv, encoded as repeated cmd parameters.",
  ),
  path: z.string().optional(),
  dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional().meta({ sensitive: true }),
  input: z.discriminatedUnion("kind", Input.options).optional().meta({
    sensitive: true,
  }),
  failOnNonZero: z.boolean().optional().default(true),
});
const ControlArgs = z.object({
  operations: z.array(ControlExecOperationArgs).min(1).max(100),
});
const ListFilesArgs = z.object({
  workingDir: z.string().min(1).optional().default("/"),
  path: z.string().min(1),
  recursive: z.boolean().optional(),
  pattern: z.string().optional(),
});
const ReadFileArgs = z.object({
  workingDir: z.string().min(1).optional().default("/"),
  path: z.string().min(1),
});
const WriteFileArgs = z.object({
  workingDir: z.string().min(1).optional().default("/"),
  path: z.string().min(1),
  content: z.discriminatedUnion("kind", Input.options).meta({
    sensitive: true,
  }),
  mode: z.string().regex(/^[0-7]{3,4}$/).optional(),
  mkdir: z.boolean().optional(),
});
const DeleteFileArgs = z.object({
  workingDir: z.string().min(1).optional().default("/"),
  path: z.string().min(1),
  recursive: z.boolean().optional().default(false),
  asRoot: z.boolean().optional().default(false),
});
const CopyFileArgs = z.object({
  source: z.string().min(1),
  dest: z.string().min(1),
  preserveAttrs: z.boolean().optional().default(false),
  workingDir: z.string().min(1).optional().default("/"),
  recursive: z.boolean().optional().default(false),
  asRoot: z.boolean().optional().default(false),
});
const RenameFileArgs = z.object({
  source: z.string().min(1),
  dest: z.string().min(1),
  workingDir: z.string().min(1).optional().default("/"),
  asRoot: z.boolean().optional().default(false),
});
const ChmodFileArgs = z.object({
  workingDir: z.string().min(1).optional().default("/"),
  path: z.string().min(1),
  recursive: z.boolean().optional().default(false),
  asRoot: z.boolean().optional().default(false),
  mode: z.string().regex(/^[0-7]{3,4}$/),
});
const ChownFileArgs = z.object({
  workingDir: z.string().min(1).optional().default("/"),
  path: z.string().min(1),
  recursive: z.boolean().optional().default(false),
  asRoot: z.boolean().optional().default(false),
  uid: z.number().int().nonnegative().optional(),
  gid: z.number().int().nonnegative().optional(),
}).refine((value) => value.uid !== undefined || value.gid !== undefined, {
  message: "Provide uid or gid.",
});
const WatchArgs = z.object({
  paths: z.array(z.string()).min(1),
  recursive: z.boolean().optional().default(false),
  workingDir: z.string().min(1).optional().default("/"),
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxEvents: z.number().int().positive().max(100_000).optional().default(1_000),
});
const SetNetworkPolicyArgs = z.object({ rules: z.array(NetworkRule) });
const SetPrivilegesPolicyArgs = z.object({
  profile: z.enum(["", "minimal", "standard", "privileged"]).optional(),
  devices: z.array(z.string()).optional(),
  noNewPrivileges: z.boolean().optional(),
});
const SetResourcesPolicyArgs = z.object({
  memory: z.object({
    limit_mb: z.number().positive(),
    autoscale: z.boolean().optional(),
  }).optional(),
});
const PortWatchArgs = z.object({
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxEvents: z.number().int().positive().max(100_000).optional().default(1_000)
    .describe(
      "Maximum incremental notifications; initial snapshot entries do not count toward this limit.",
    ),
});
const ProxyArgs = z.object({
  localPort: z.number().int().min(1).max(65_535).describe(
    "Required port bound only on the IPv4 loopback interface.",
  ),
  host: z.string().min(1).describe(
    "Remote host reached from inside the Sprite.",
  ),
  port: z.number().int().min(1).max(65_535).describe(
    "Remote TCP port reached from inside the Sprite.",
  ),
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxConnections: z.number().int().positive().max(1_024).optional().default(32),
});
const GatewayRequestArgs = z.object({
  provider: z.string().min(1),
  connection_id: z.string().min(1),
  providerPath: z.string().min(1).refine(
    validProviderPath,
    "providerPath must be an absolute provider path without a host, traversal, fragment, or header sequence.",
  ),
  method: z.string().pipe(ProviderMethod),
  headers: z.record(z.string(), z.string()).meta({ sensitive: true }).optional()
    .default({}),
  input: z.discriminatedUnion("kind", Input.options).optional().meta({
    sensitive: true,
  }),
});
/** One Sprite, scoped to one organization credential. Methods retain native API argument names. */
export const model = {
  type: "@josh/sprites/sprite",
  version: "2026.09.11.1",
  globalArguments: SpriteArgsSchema,
  resources: {
    state: {
      schema: SpriteResponse,
      description: "Current provider metadata for this Sprite",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    probeUrl: {
      schema: UrlProbe,
      description:
        "Authenticated root URL response fingerprint; not a general application health guarantee",
      lifetime: "7d",
      garbageCollection: 10,
    },
    listCheckpoints: {
      schema: Checkpoints,
      description: "Sprite checkpoints",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    controlExec: {
      schema: ControlExecution,
      description:
        "Sequential control-channel exec result and artifact byte ranges",
      lifetime: "7d",
      garbageCollection: 10,
    },
    exec: {
      schema: Execution,
      description: "Command result or detached session identity",
      lifetime: "7d",
      garbageCollection: 10,
    },
    attach: {
      schema: Execution,
      description: "Command result or detached session identity",
      lifetime: "7d",
      garbageCollection: 10,
    },
    execHttp: {
      schema: Execution,
      description: "Command result or detached session identity",
      lifetime: "7d",
      garbageCollection: 10,
    },
    listSessions: {
      schema: Sessions,
      description: "Exec sessions",
      lifetime: "7d",
      garbageCollection: 10,
    },
    killSession: {
      schema: Killed,
      description: "Session termination progress",
      lifetime: "7d",
      garbageCollection: 10,
    },
    listFiles: {
      schema: FsList,
      description: "Native filesystem directory listing",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    writeFile: {
      schema: FsWrite,
      description: "Native filesystem write result",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deleteFile: {
      schema: FsDelete,
      description: "Native filesystem deletion result",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    copyFile: {
      schema: FsCopy,
      description: "Native filesystem copy result",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    renameFile: {
      schema: FsRename,
      description: "Native filesystem rename result",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    chmodFile: {
      schema: FsChmod,
      description: "Native filesystem chmod result",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    chownFile: {
      schema: FsChown,
      description: "Native filesystem chown result",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    watch: {
      schema: WatchOutput,
      description:
        "Bounded filesystem watch events; never an exhaustive history",
      lifetime: "7d",
      garbageCollection: 10,
    },
    getNetworkPolicy: {
      schema: NetworkPolicy,
      description: "Sprite network policy",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    getPrivilegesPolicy: {
      schema: PrivilegesPolicy,
      description: "Sprite privilege policy",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    getResourcesPolicy: {
      schema: ResourcesPolicy,
      description: "Sprite resource policy",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    watchPorts: {
      schema: PortWatchOutput,
      description:
        "Initial listening-port snapshot and bounded incremental notifications",
      lifetime: "7d",
      garbageCollection: 10,
    },
    proxy: {
      schema: ProxyOutput,
      description: "Closed loopback TCP proxy observation",
      lifetime: "7d",
      garbageCollection: 10,
    },
    listServices: {
      schema: Services,
      description: "Configured Sprite services",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    listTasks: {
      schema: Tasks,
      description:
        "Observed task holds; this snapshot does not keep a Sprite awake",
      lifetime: "7d",
      garbageCollection: 10,
    },
    gatewayList: {
      schema: GatewayList,
      description:
        "Gateway connections and available providers with source-defined open metadata",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    gatewayRequest: {
      schema: GatewayResponse,
      description: "Provider HTTP status and response headers",
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  files: {
    controlExecStdout: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    controlExecStderr: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    execStdout: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    execStderr: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    attachStdout: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    attachStderr: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    execHttpStdout: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    execHttpStderr: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    readFile: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    gatewayRequestBody: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    create: {
      description: "Create the configured Sprite",
      arguments: CreateArgs,
      execute: (args: z.output<typeof CreateArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("create"),
          "state",
          SpriteResponse,
          async () => {
            const saved = z.object({ id: z.string() }).safeParse(
              await ctx.readResource("state"),
            );
            if (saved.success) {
              throw new Error(
                "A Sprite identity is already saved. Use another instance to create a Sprite.",
              );
            }
            return jsonRequest(ctx, "POST", "/v1/sprites", SpriteResponse, {
              json: { name: ctx.globalArgs.name, ...args },
            });
          },
        ),
    },
    lookup: {
      description: "Read the configured Sprite",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("lookup"),
          "state",
          SpriteResponse,
          () =>
            jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.name),
              SpriteResponse,
            ),
        ),
    },
    update: {
      description: "Update the configured Sprite",
      arguments: UpdateArgs,
      execute: (args: z.output<typeof UpdateArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("update"),
          "state",
          SpriteResponse,
          async () => {
            await verifySprite(ctx);
            return jsonRequest(
              ctx,
              "PUT",
              spritePath(ctx.globalArgs.name),
              SpriteResponse,
              { json: args },
            );
          },
        ),
    },
    upgrade: {
      description:
        "Request a runtime upgrade; success only acknowledges provider acceptance",
      arguments: z.object({ version: z.string().min(1).optional() }),
      execute: (args: { version?: string }, ctx: SpriteContext) =>
        runMethod(ctx, methodDescription("upgrade"), null, async () => {
          await verifySprite(ctx);
          await emptyRequest(
            ctx,
            "POST",
            spritePath(ctx.globalArgs.name, "/upgrade"),
            args.version === undefined
              ? {}
              : { json: { version: args.version } },
          );
        }),
    },
    restart: {
      description: "Request a restart of the machine backing this Sprite",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(ctx, methodDescription("restart"), null, async () => {
          await verifySprite(ctx);
          await emptyRequest(
            ctx,
            "POST",
            spritePath(ctx.globalArgs.name, "/restart"),
          );
        }),
    },
    probeUrl: {
      description:
        "Check the verified Sprite root URL and fingerprint its response",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("probeUrl"),
          "probeUrl",
          UrlProbe,
          async () => {
            const operation = deadline(ctx);
            const { signal } = operation;
            try {
              const state = await verifySprite({ ...ctx, signal });
              const url = new URL(state.url);
              if (
                url.protocol !== "https:" ||
                !url.hostname.endsWith(".sprites.app") ||
                !url.hostname.startsWith(`${ctx.globalArgs.name}-`) ||
                url.username || url.password || url.port ||
                url.pathname !== "/" || url.search || url.hash
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
                throw new Error(
                  `Sprite URL probe returned HTTP ${response.status}.`,
                );
              }
              const bytes = await responseBytes(
                response,
                ctx.globalArgs.maxResponseBytes,
              );
              return {
                bodyBytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              };
            } finally {
              operation.dispose();
            }
          },
        ),
    },
    delete: {
      description: "Delete the configured Sprite",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(ctx, methodDescription("delete"), null, async () => {
          try {
            await verifySprite(ctx);
          } catch (error) {
            if (
              !(error instanceof ApiError && error.status === 404)
            ) throw error;
            await ctx.deleteResource("state");
            return;
          }
          try {
            await emptyRequest(ctx, "DELETE", spritePath(ctx.globalArgs.name));
          } catch (error) {
            if (
              !(error instanceof ApiError && error.status === 404)
            ) throw error;
          }
          await ctx.deleteResource("state");
        }),
    },
    listCheckpoints: {
      description: "List Sprite checkpoints",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("listCheckpoints"),
          "listCheckpoints",
          Checkpoints,
          async () => ({
            checkpoints: await jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.name, "/checkpoints"),
              z.array(Checkpoint),
            ),
          }),
        ),
    },
    controlExec: {
      description:
        "Run bounded sequential exec operations over one persistent WebSocket",
      arguments: ControlArgs,
      execute: (
        args: z.output<typeof ControlArgs>,
        ctx: RuntimeSpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("controlExec"),
          "controlExec",
          ControlExecution,
          async () => {
            await verifySprite(ctx);
            return saveControlExecution(
              ctx,
              await (ctx.controlExec ?? executeControl)(ctx, args),
            );
          },
        ),
    },
    exec: {
      description:
        "Execute a command over WebSocket with binary output and optional TTY controls",
      arguments: ExecArgs,
      execute: (args: z.output<typeof ExecArgs>, ctx: RuntimeSpriteContext) =>
        runMethod(
          ctx,
          methodDescription("exec"),
          "exec",
          Execution,
          () =>
            runSocketExecution(
              ctx,
              args as z.output<typeof NativeExecArgs>,
              ctx.socketExec,
            ),
        ),
    },
    attach: {
      description:
        "Attach to an existing exec session and exchange input, output, and controls",
      arguments: AttachArgs,
      execute: (args: z.output<typeof AttachArgs>, ctx: RuntimeSpriteContext) =>
        runMethod(
          ctx,
          methodDescription("attach"),
          "attach",
          Execution,
          () =>
            runSocketExecution(
              ctx,
              args as z.output<typeof NativeAttachArgs>,
              ctx.socketExec,
            ),
        ),
    },
    execHttp: {
      description:
        "Execute over HTTP/1.1 while preserving provider chunk framing",
      arguments: HttpExecArgs,
      execute: (
        args: z.output<typeof HttpExecArgs>,
        ctx: RuntimeSpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("execHttp"),
          "execHttp",
          Execution,
          async () => {
            await verifySprite(ctx);
            const result = await (ctx.managementExec ?? executeHttp)(
              ctx,
              ctx.globalArgs.name,
              {
                cmd: args.cmd,
                path: args.path,
                dir: args.dir,
                env: envPairs(args.env),
                stdin: args.input !== undefined,
              },
              inputBytes(args.input),
            );
            return saveExecution(
              ctx,
              { ...result, status: "exited", sessionId: null, controls: [] },
              args.failOnNonZero,
              "execHttp",
            );
          },
        ),
    },
    listSessions: {
      description: "List exec sessions",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("listSessions"),
          "listSessions",
          Sessions,
          () =>
            jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.name, "/exec"),
              Sessions,
            ),
        ),
    },
    killSession: {
      description: "Kill an exec session",
      arguments: z.object({
        session_id: z.string().min(1),
        signal: z.string().optional(),
        timeout: z.string().optional(),
      }),
      execute: (
        args: { session_id: string; signal?: string; timeout?: string },
        ctx: SpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("killSession"),
          "killSession",
          Killed,
          async () => {
            await verifySprite(ctx);
            const events = await ndjson(
              ctx,
              "POST",
              spritePath(
                ctx.globalArgs.name,
                `/exec/${segment(args.session_id)}/kill`,
              ),
              KillEvent,
              { query: { signal: args.signal, timeout: args.timeout } },
            );
            if (
              !events.some((event) => event.type === "complete")
            ) {
              throw new Error("Session kill stream ended without completion.");
            }
            return { events };
          },
        ),
    },
    listFiles: {
      description: "List a Sprite directory",
      arguments: ListFilesArgs,
      execute: (args: z.output<typeof ListFilesArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("listFiles"),
          "listFiles",
          FsList,
          () =>
            jsonRequest(ctx, "GET", fsPath(ctx, "list"), FsList, {
              query: args,
            }),
        ),
    },
    readFile: {
      description: "Read raw bytes from a Sprite file",
      arguments: ReadFileArgs,
      execute: (args: z.output<typeof ReadFileArgs>, ctx: SpriteContext) =>
        runMethod(ctx, methodDescription("readFile"), null, async () => {
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
        }),
    },
    writeFile: {
      description: "Write raw bytes to a Sprite file",
      arguments: WriteFileArgs,
      execute: (args: z.output<typeof WriteFileArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("writeFile"),
          "writeFile",
          FsWrite,
          async () => {
            await verifySprite(ctx);
            return jsonRequest(ctx, "PUT", fsPath(ctx, "write"), FsWrite, {
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
    },
    deleteFile: {
      description: "Delete a Sprite file or directory",
      arguments: DeleteFileArgs,
      execute: (args: z.output<typeof DeleteFileArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("deleteFile"),
          "deleteFile",
          FsDelete,
          async () => {
            await verifySprite(ctx);
            return jsonRequest(ctx, "DELETE", fsPath(ctx, "delete"), FsDelete, {
              json: args,
            });
          },
        ),
    },
    copyFile: {
      description: "Copy a Sprite file or directory",
      arguments: CopyFileArgs,
      execute: (args: z.output<typeof CopyFileArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("copyFile"),
          "copyFile",
          FsCopy,
          async () => {
            await verifySprite(ctx);
            return jsonRequest(ctx, "POST", fsPath(ctx, "copy"), FsCopy, {
              json: args,
            });
          },
        ),
    },
    renameFile: {
      description: "Rename a Sprite file or directory",
      arguments: RenameFileArgs,
      execute: (args: z.output<typeof RenameFileArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("renameFile"),
          "renameFile",
          FsRename,
          async () => {
            await verifySprite(ctx);
            return jsonRequest(ctx, "POST", fsPath(ctx, "rename"), FsRename, {
              json: args,
            });
          },
        ),
    },
    chmodFile: {
      description: "Change Sprite file permissions",
      arguments: ChmodFileArgs,
      execute: (args: z.output<typeof ChmodFileArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("chmodFile"),
          "chmodFile",
          FsChmod,
          async () => {
            await verifySprite(ctx);
            return jsonRequest(ctx, "POST", fsPath(ctx, "chmod"), FsChmod, {
              json: args,
            });
          },
        ),
    },
    chownFile: {
      description: "Change Sprite file ownership",
      arguments: ChownFileArgs,
      execute: (args: z.output<typeof ChownFileArgs>, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("chownFile"),
          "chownFile",
          FsChown,
          async () => {
            await verifySprite(ctx);
            return jsonRequest(ctx, "POST", fsPath(ctx, "chown"), FsChown, {
              json: args,
            });
          },
        ),
    },
    watch: {
      description:
        "Observe acknowledged Sprite filesystem events for a bounded duration",
      arguments: WatchArgs,
      execute: (args: z.output<typeof WatchArgs>, ctx: RuntimeSpriteContext) =>
        runMethod(
          ctx,
          methodDescription("watch"),
          "watch",
          WatchOutput,
          () => (ctx.watch ?? observeWatch)(ctx, args),
        ),
    },
    getNetworkPolicy: {
      description: "Read the Sprite network policy",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("getNetworkPolicy"),
          "getNetworkPolicy",
          NetworkPolicy,
          () =>
            jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.name, "/policy/network"),
              NetworkPolicy,
            ),
        ),
    },
    setNetworkPolicy: {
      description: "Replace the Sprite network policy",
      arguments: SetNetworkPolicyArgs,
      execute: (
        args: z.output<typeof SetNetworkPolicyArgs>,
        ctx: SpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("setNetworkPolicy"),
          null,
          async () => {
            await verifySprite(ctx);
            await emptyRequest(
              ctx,
              "POST",
              spritePath(ctx.globalArgs.name, "/policy/network"),
              { json: args },
            );
          },
        ),
    },
    getPrivilegesPolicy: {
      description: "Read the Sprite privilege policy",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("getPrivilegesPolicy"),
          "getPrivilegesPolicy",
          PrivilegesPolicy,
          () =>
            jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.name, "/policy/privileges"),
              PrivilegesPolicy,
            ),
        ),
    },
    setPrivilegesPolicy: {
      description: "Set the Sprite privilege policy",
      arguments: SetPrivilegesPolicyArgs,
      execute: (
        args: z.output<typeof SetPrivilegesPolicyArgs>,
        ctx: SpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("setPrivilegesPolicy"),
          null,
          async () => {
            await verifySprite(ctx);
            await emptyRequest(
              ctx,
              "POST",
              spritePath(ctx.globalArgs.name, "/policy/privileges"),
              { json: args },
            );
          },
        ),
    },
    deletePrivilegesPolicy: {
      description: "Remove the Sprite privilege policy",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("deletePrivilegesPolicy"),
          null,
          async () => {
            await verifySprite(ctx);
            await emptyRequest(
              ctx,
              "DELETE",
              spritePath(ctx.globalArgs.name, "/policy/privileges"),
            );
          },
        ),
    },
    getResourcesPolicy: {
      description: "Read the Sprite resource policy",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("getResourcesPolicy"),
          "getResourcesPolicy",
          ResourcesPolicy,
          () =>
            jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.name, "/policy/resources"),
              ResourcesPolicy,
            ),
        ),
    },
    setResourcesPolicy: {
      description: "Set the Sprite resource policy",
      arguments: SetResourcesPolicyArgs,
      execute: (
        args: z.output<typeof SetResourcesPolicyArgs>,
        ctx: SpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("setResourcesPolicy"),
          null,
          async () => {
            await verifySprite(ctx);
            await emptyRequest(
              ctx,
              "POST",
              spritePath(ctx.globalArgs.name, "/policy/resources"),
              { json: args },
            );
          },
        ),
    },
    deleteResourcesPolicy: {
      description: "Remove the Sprite resource policy",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("deleteResourcesPolicy"),
          null,
          async () => {
            await verifySprite(ctx);
            await emptyRequest(
              ctx,
              "DELETE",
              spritePath(ctx.globalArgs.name, "/policy/resources"),
            );
          },
        ),
    },
    watchPorts: {
      description:
        "Observe a Sprite listening-port snapshot and bounded open/close notifications",
      arguments: PortWatchArgs,
      execute: (
        args: z.output<typeof PortWatchArgs>,
        ctx: RuntimeSpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("watchPorts"),
          "watchPorts",
          PortWatchOutput,
          () => (ctx.portWatch ?? watchPorts)(ctx, args),
        ),
    },
    proxy: {
      description: "Run a bounded loopback-only TCP proxy through the Sprite",
      arguments: ProxyArgs,
      execute: (args: z.output<typeof ProxyArgs>, ctx: RuntimeSpriteContext) =>
        runMethod(
          ctx,
          methodDescription("proxy"),
          "proxy",
          ProxyOutput,
          () => (ctx.proxy ?? runProxy)(ctx, args),
        ),
    },
    listServices: {
      description: "List configured Sprite services",
      arguments: z.object({}),
      execute: (_args: object, ctx: SpriteContext) =>
        runMethod(
          ctx,
          methodDescription("listServices"),
          "listServices",
          Services,
          async () => ({
            services: await jsonRequest(
              ctx,
              "GET",
              spritePath(ctx.globalArgs.name, "/services"),
              z.array(Service),
            ),
          }),
        ),
    },
    listTasks: {
      description:
        "List active task holds through the Sprite management socket",
      arguments: z.object({}),
      execute: (_args: object, ctx: RuntimeSpriteContext) =>
        runMethod(
          ctx,
          methodDescription("listTasks"),
          "listTasks",
          Tasks,
          () => listTasks(ctx, ctx.managementExec ?? executeHttp),
        ),
    },
    gatewayList: {
      description:
        "Discover connector access from inside the configured Sprite",
      arguments: z.object({}),
      execute: (_args: object, ctx: RuntimeSpriteContext) =>
        runMethod(
          ctx,
          methodDescription("gatewayList"),
          "gatewayList",
          GatewayList,
          async () => {
            await verifySprite(ctx);
            return (ctx.gatewayDiscover ?? discoverGateway)(ctx);
          },
        ),
    },
    gatewayRequest: {
      description:
        "Relay one provider path through a configured Sprite connector",
      arguments: GatewayRequestArgs,
      execute: (
        args: z.output<typeof GatewayRequestArgs>,
        ctx: RuntimeSpriteContext,
      ) =>
        runMethod(
          ctx,
          methodDescription("gatewayRequest"),
          "gatewayRequest",
          GatewayResponse,
          async () => {
            await verifySprite(ctx);
            const response = await (ctx.gatewayRelay ?? relayGateway)(
              ctx,
              args,
            );
            ctx.signal.throwIfAborted();
            const { body, ...metadata } = response;
            const bodyHandle = await ctx.createFileWriter(
              "gatewayRequestBody",
              "gatewayRequestBody",
            ).writeAll(body);
            return withHandles(metadata, [bodyHandle]);
          },
        ),
    },
  },
};
