// SPDX-License-Identifier: MIT

/**
 * The Fly organization the token belongs to.
 * The model keeps API credentials out of stored data and preserves API Sprite
 * fields for other models to read with CEL expressions.
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import {
  ApiError,
  AuthSchema,
  BinaryFile,
  type Context,
  emptyRequest,
  Environment,
  inputBytes,
  jsonRequest,
  method,
  resource,
  segment,
  withHandles,
} from "./_lib/core.ts";

import { Checkpoint, checkpointStream } from "./_lib/checkpoints.ts";
import { CommandArgs, envPairs, executeHttp } from "./_lib/exec.ts";
import { type ManagementExec } from "./_lib/local-api.ts";
import { Service, serviceStream } from "./_lib/services.ts";

import { connectorsMethods, connectorsResources } from "./_lib/connectors.ts";

import {
  NetworkPolicy,
  PrivilegesPolicy,
  ResourcesPolicy,
} from "./_lib/policy.ts";

import { spritePath, SpriteResponse } from "./_lib/sprite.ts";

import {
  fanOut,
  listAllSprites,
  LookupArgsSchema,
  recordSchema,
  SpriteSelector,
  summarySchema,
} from "./_lib/fanout.ts";

const InventorySchema = z.object({
  organization: z.object({
    name: z.string(),
    runningLimit: z.number().int().nonnegative().nullable(),
    warmLimit: z.number().int().nonnegative().nullable(),
  }),
  counts: z.object({
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    warm: z.number().int().nonnegative(),
    cold: z.number().int().nonnegative(),
  }),
  sprites: z.array(SpriteResponse),
  prefix: z.string().nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});

const network = z.object({ policy: NetworkPolicy.nullable().optional() });
const privileges = z.object({ policy: PrivilegesPolicy.nullable().optional() });
const resources = z.object({ policy: ResourcesPolicy.nullable().optional() });
const upgradeExtra = z.object({ version: z.string().nullable().optional() });
const emptyExtra = z.object({});
const checkpointExtra = z.object({
  checkpoint: Checkpoint.nullable().optional(),
});
const serviceExtra = z.object({
  exitCode: z.number().int().nullable().optional(),
  service: Service.nullable().optional(),
});
const serviceExitExtra = z.object({
  exitCode: z.number().int().nullable().optional(),
});

const execExtra = z.object({
  exitCode: z.number().int().nullable(),
  stdoutBytes: z.number().int().nonnegative().nullable(),
  stderrBytes: z.number().int().nonnegative().nullable(),
}).partial();
const ExecSummary = summarySchema(execExtra).extend({
  nonzero: z.number().int().nonnegative(),
});

/** The Fly organization the token belongs to: its Sprites and its connections. */
export const model = {
  type: "@josh/sprites/organization",
  version: "2026.09.11.1",
  // Inventory allows 30 seconds per page, including larger organization lists.
  globalArguments: AuthSchema.extend({
    timeoutMs: AuthSchema.shape.timeoutMs.default(30_000),
  }),
  files: { spriteExecStdout: BinaryFile, spriteExecStderr: BinaryFile },
  resources: {
    ...connectorsResources,
    setNetworkPolicy: resource(
      summarySchema(network),
      "Last setNetworkPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteSetNetworkPolicy: resource(
      recordSchema(network),
      "One Sprite's outcome of setNetworkPolicy; instance name setNetworkPolicy-<sprite>",
    ),
    setPrivilegesPolicy: resource(
      summarySchema(privileges),
      "Last setPrivilegesPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteSetPrivilegesPolicy: resource(
      recordSchema(privileges),
      "One Sprite's outcome of setPrivilegesPolicy; instance name setPrivilegesPolicy-<sprite>",
    ),
    setResourcesPolicy: resource(
      summarySchema(resources),
      "Last setResourcesPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteSetResourcesPolicy: resource(
      recordSchema(resources),
      "One Sprite's outcome of setResourcesPolicy; instance name setResourcesPolicy-<sprite>",
    ),
    deletePrivilegesPolicy: resource(
      summarySchema(emptyExtra),
      "Last deletePrivilegesPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteDeletePrivilegesPolicy: resource(
      recordSchema(emptyExtra),
      "One Sprite's outcome of deletePrivilegesPolicy; instance name deletePrivilegesPolicy-<sprite>",
    ),
    deleteResourcesPolicy: resource(
      summarySchema(emptyExtra),
      "Last deleteResourcesPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteDeleteResourcesPolicy: resource(
      recordSchema(emptyExtra),
      "One Sprite's outcome of deleteResourcesPolicy; instance name deleteResourcesPolicy-<sprite>",
    ),
    getNetworkPolicy: resource(
      summarySchema(network),
      "Last getNetworkPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteGetNetworkPolicy: resource(
      recordSchema(network),
      "One Sprite's outcome of getNetworkPolicy; instance name getNetworkPolicy-<sprite>",
    ),
    getPrivilegesPolicy: resource(
      summarySchema(privileges),
      "Last getPrivilegesPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteGetPrivilegesPolicy: resource(
      recordSchema(privileges),
      "One Sprite's outcome of getPrivilegesPolicy; instance name getPrivilegesPolicy-<sprite>",
    ),
    getResourcesPolicy: resource(
      summarySchema(resources),
      "Last getResourcesPolicy run: which Sprites it matched, applied to, and failed on",
    ),
    spriteGetResourcesPolicy: resource(
      recordSchema(resources),
      "One Sprite's outcome of getResourcesPolicy; instance name getResourcesPolicy-<sprite>",
    ),
    upgrade: resource(
      summarySchema(upgradeExtra),
      "Last upgrade run: which Sprites it matched, applied to, and failed on",
    ),
    spriteUpgrade: resource(
      recordSchema(upgradeExtra),
      "One Sprite's outcome of upgrade; instance name upgrade-<sprite>",
    ),
    restart: resource(
      summarySchema(emptyExtra),
      "Last restart run: which Sprites it matched, applied to, and failed on",
    ),
    spriteRestart: resource(
      recordSchema(emptyExtra),
      "One Sprite's outcome of restart; instance name restart-<sprite>",
    ),
    createCheckpoint: resource(
      summarySchema(checkpointExtra),
      "Last createCheckpoint run: which Sprites it matched, applied to, and failed on",
    ),
    spriteCreateCheckpoint: resource(
      recordSchema(checkpointExtra),
      "One Sprite's outcome of createCheckpoint; instance name createCheckpoint-<sprite>",
    ),
    putService: resource(
      summarySchema(serviceExtra),
      "Last putService run: which Sprites it matched, applied to, and failed on",
    ),
    spritePutService: resource(
      recordSchema(serviceExtra),
      "One Sprite's outcome of putService; instance name putService-<service_name>-<sprite>",
    ),
    startService: resource(
      summarySchema(serviceExitExtra),
      "Last startService run: which Sprites it matched, applied to, and failed on",
    ),
    spriteStartService: resource(
      recordSchema(serviceExitExtra),
      "One Sprite's outcome of startService; instance name startService-<service_name>-<sprite>",
    ),
    stopService: resource(
      summarySchema(serviceExitExtra),
      "Last stopService run: which Sprites it matched, applied to, and failed on",
    ),
    spriteStopService: resource(
      recordSchema(serviceExitExtra),
      "One Sprite's outcome of stopService; instance name stopService-<service_name>-<sprite>",
    ),
    restartService: resource(
      summarySchema(serviceExitExtra),
      "Last restartService run: which Sprites it matched, applied to, and failed on",
    ),
    spriteRestartService: resource(
      recordSchema(serviceExitExtra),
      "One Sprite's outcome of restartService; instance name restartService-<service_name>-<sprite>",
    ),
    deleteService: resource(
      summarySchema(emptyExtra),
      "Last deleteService run: which Sprites it matched, applied to, and failed on",
    ),
    spriteDeleteService: resource(
      recordSchema(emptyExtra),
      "One Sprite's outcome of deleteService; instance name deleteService-<service_name>-<sprite>",
    ),
    exec: resource(
      ExecSummary,
      "Last exec run: which Sprites it matched, applied to, and failed on",
    ),
    spriteExec: resource(
      recordSchema(execExtra),
      "One Sprite's outcome of exec; instance name exec-<sprite>",
    ),
    listSprites: resource(
      InventorySchema,
      "Current Sprites and capacity limits for one organization",
    ),
  },
  methods: createMethods(),
};

/** Methods accept the HTTP exec transport so tests can replace it. */
export function createMethods(execute: ManagementExec = executeHttp) {
  return {
    exec: method(
      "Run one command on every Sprite the selector matches over HTTP exec; a nonzero exit is recorded, not failed; stdout and stderr are saved per Sprite as exec-stdout-<sprite> and exec-stderr-<sprite>",
      CommandArgs.omit({ failOnNonZero: true }).extend({
        select: SpriteSelector,
      }),
      "exec",
      ExecSummary,
      async (args, context: Context) => {
        const summary = await fanOut(
          context,
          args.select,
          "spriteExec",
          "exec",
          execExtra,
          async (sprite) => {
            const result = await execute(context, sprite.name, {
              cmd: args.cmd,
              path: args.path,
              dir: args.dir,
              env: envPairs(args.env),
              stdin: args.input !== undefined,
            }, inputBytes(args.input));
            context.signal.throwIfAborted();
            const stdout = await context.createFileWriter(
              "spriteExecStdout",
              `exec-stdout-${sprite.name}`,
            ).writeAll(result.stdout);
            const stderr = await context.createFileWriter(
              "spriteExecStderr",
              `exec-stderr-${sprite.name}`,
            ).writeAll(result.stderr);
            return {
              handles: [stdout, stderr],
              exitCode: result.exitCode,
              stdoutBytes: result.stdout.length,
              stderrBytes: result.stderr.length,
            };
          },
        );
        const nonzero =
          summary.data.results.filter((row) =>
            row.status === "applied" && row.exitCode !== 0
          ).length;
        return withHandles({ ...summary.data, nonzero }, summary.handles);
      },
    ),
    listSprites: method(
      "Read every Sprite visible to the organization token",
      LookupArgsSchema,
      "listSprites",
      InventorySchema,
      async (args, context: Context) => {
        const budget = { remaining: context.globalArgs.maxResponseBytes };
        const { organization, sprites } = await listAllSprites(
          context,
          args,
          budget,
        );

        const statusCounts = { running: 0, warm: 0, cold: 0 };
        for (const sprite of sprites) {
          statusCounts[sprite.status] += 1;
        }

        const inventory = {
          organization,
          counts: {
            total: sprites.length,
            ...statusCounts,
          },
          sprites,
          prefix: args.prefix ?? null,
          observedAt: new Date().toISOString(),
        };

        context.logger.info("Read {count} Sprites for organization {name}", {
          count: inventory.counts.total,
          name: inventory.organization.name,
        });

        return inventory;
      },
    ),
    setNetworkPolicy: method(
      "Replace the network policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as setNetworkPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: NetworkPolicy }),
      "setNetworkPolicy",
      summarySchema(network),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteSetNetworkPolicy",
          "setNetworkPolicy",
          network,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/policy/network"),
              { json: args.policy },
            );
            return { policy: args.policy };
          },
        ),
    ),
    setPrivilegesPolicy: method(
      "Set the privileges policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as setPrivilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: PrivilegesPolicy }),
      "setPrivilegesPolicy",
      summarySchema(privileges),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteSetPrivilegesPolicy",
          "setPrivilegesPolicy",
          privileges,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/policy/privileges"),
              { json: args.policy },
            );
            return { policy: args.policy };
          },
        ),
    ),
    setResourcesPolicy: method(
      "Set the resources policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as setResourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: ResourcesPolicy }),
      "setResourcesPolicy",
      summarySchema(resources),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteSetResourcesPolicy",
          "setResourcesPolicy",
          resources,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/policy/resources"),
              { json: args.policy },
            );
            return { policy: args.policy };
          },
        ),
    ),
    deletePrivilegesPolicy: method(
      "Remove the privileges policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as deletePrivilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "deletePrivilegesPolicy",
      summarySchema(emptyExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteDeletePrivilegesPolicy",
          "deletePrivilegesPolicy",
          emptyExtra,
          async (sprite) => {
            await emptyRequest(
              context,
              "DELETE",
              spritePath(sprite.name, "/policy/privileges"),
            );
            return {};
          },
        ),
    ),
    deleteResourcesPolicy: method(
      "Remove the resources policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as deleteResourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "deleteResourcesPolicy",
      summarySchema(emptyExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteDeleteResourcesPolicy",
          "deleteResourcesPolicy",
          emptyExtra,
          async (sprite) => {
            await emptyRequest(
              context,
              "DELETE",
              spritePath(sprite.name, "/policy/resources"),
            );
            return {};
          },
        ),
    ),
    getNetworkPolicy: method(
      "Read the network policy from every Sprite the selector matches; each Sprite's outcome is also saved as getNetworkPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "getNetworkPolicy",
      summarySchema(network),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteGetNetworkPolicy",
          "getNetworkPolicy",
          network,
          async (sprite) => {
            const policy = await jsonRequest(
              context,
              "GET",
              spritePath(sprite.name, "/policy/network"),
              NetworkPolicy,
            );
            return { policy };
          },
        ),
    ),
    getPrivilegesPolicy: method(
      "Read the privileges policy from every Sprite the selector matches; each Sprite's outcome is also saved as getPrivilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "getPrivilegesPolicy",
      summarySchema(privileges),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteGetPrivilegesPolicy",
          "getPrivilegesPolicy",
          privileges,
          async (sprite) => {
            const policy = await jsonRequest(
              context,
              "GET",
              spritePath(sprite.name, "/policy/privileges"),
              PrivilegesPolicy,
            );
            return { policy };
          },
        ),
    ),
    getResourcesPolicy: method(
      "Read the resources policy from every Sprite the selector matches; each Sprite's outcome is also saved as getResourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "getResourcesPolicy",
      summarySchema(resources),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteGetResourcesPolicy",
          "getResourcesPolicy",
          resources,
          async (sprite) => {
            const policy = await jsonRequest(
              context,
              "GET",
              spritePath(sprite.name, "/policy/resources"),
              ResourcesPolicy,
            );
            return { policy };
          },
        ),
    ),
    // Not in either API reference; verified live.
    upgrade: method(
      "Request a runtime upgrade on every Sprite the selector matches; success only records provider acceptance",
      z.object({ select: SpriteSelector, version: z.string().optional() }),
      "upgrade",
      summarySchema(upgradeExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteUpgrade",
          "upgrade",
          upgradeExtra,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/upgrade"),
              args.version ? { json: { version: args.version } } : {},
            );
            return { version: args.version ?? null };
          },
        ),
    ),
    // Not in either API reference; verified live.
    restart: method(
      "Request a restart on every Sprite the selector matches; success only records provider acceptance",
      z.object({ select: SpriteSelector }),
      "restart",
      summarySchema(emptyExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteRestart",
          "restart",
          emptyExtra,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/restart"),
            );
            return {};
          },
        ),
    ),
    createCheckpoint: method(
      "Take a checkpoint on every Sprite the selector matches; each Sprite's outcome is also saved as createCheckpoint-<sprite>",
      z.object({ select: SpriteSelector, comment: z.string().optional() }),
      "createCheckpoint",
      summarySchema(checkpointExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteCreateCheckpoint",
          "createCheckpoint",
          checkpointExtra,
          async (sprite) => {
            await checkpointStream(
              context,
              spritePath(sprite.name, "/checkpoint"),
              { comment: args.comment },
            );
            // The complete event carries progress text, not the new id, so take the newest listed
            // checkpoint. A checkpoint someone else creates at the same moment could win that race.
            const checkpoints = await jsonRequest(
              context,
              "GET",
              spritePath(sprite.name, "/checkpoints"),
              z.array(Checkpoint),
            );
            const newest = checkpoints.reduce<
              z.output<typeof Checkpoint> | undefined
            >(
              (latest, candidate) =>
                !latest ||
                  Date.parse(candidate.create_time) >
                    Date.parse(latest.create_time)
                  ? candidate
                  : latest,
              undefined,
            );
            if (!newest) {
              throw new Error(
                "Checkpoint creation completed but no checkpoint was listed.",
              );
            }
            return { checkpoint: newest };
          },
        ),
    ),
    putService: method(
      "Create or update the named service on every Sprite the selector matches; each Sprite's outcome is also saved as putService-<service_name>-<sprite>",
      z.object({
        select: SpriteSelector,
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
      "putService",
      summarySchema(serviceExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spritePutService",
          `putService-${args.service_name}`,
          serviceExtra,
          async (sprite) => {
            const path = spritePath(
              sprite.name,
              `/services/${segment(args.service_name)}`,
            );
            const { events } = await serviceStream(context, "PUT", path, {
              query: { duration: args.duration },
              json: args.service,
            }, "progress");
            const exited = events.find((event) => event.type === "exit");
            if (exited) {
              return {
                failed: `exited during startup with code ${exited.exit_code}`,
                exitCode: exited.exit_code,
                service: null,
              };
            }
            const service = await jsonRequest(context, "GET", path, Service);
            return { exitCode: null, service };
          },
        ),
    ),
    startService: method(
      "Start the named service on every Sprite the selector matches; each Sprite's outcome is also saved as startService-<service_name>-<sprite>",
      z.object({
        select: SpriteSelector,
        service_name: z.string().min(1),
        duration: z.string().min(1).optional(),
      }),
      "startService",
      summarySchema(serviceExitExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteStartService",
          `startService-${args.service_name}`,
          serviceExitExtra,
          async (sprite) => {
            const path = spritePath(
              sprite.name,
              `/services/${segment(args.service_name)}`,
            );
            const { events } = await serviceStream(
              context,
              "POST",
              `${path}/start`,
              { query: { duration: args.duration } },
              "progress",
            );
            const exited = events.find((event) => event.type === "exit");
            if (exited) {
              return {
                failed: `exited during startup with code ${exited.exit_code}`,
                exitCode: exited.exit_code,
              };
            }
            await jsonRequest(context, "GET", path, Service);
            return { exitCode: null };
          },
        ),
    ),
    stopService: method(
      "Stop the named service on every Sprite the selector matches; each Sprite's outcome is also saved as stopService-<service_name>-<sprite>",
      z.object({
        select: SpriteSelector,
        service_name: z.string().min(1),
        timeout: z.string().min(1).optional(),
      }),
      "stopService",
      summarySchema(serviceExitExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteStopService",
          `stopService-${args.service_name}`,
          serviceExitExtra,
          async (sprite) => {
            const path = spritePath(
              sprite.name,
              `/services/${segment(args.service_name)}`,
            );
            const { events } = await serviceStream(
              context,
              "POST",
              `${path}/stop`,
              { query: { timeout: args.timeout } },
              "progress",
            );
            const stopped = events.find((event) =>
              event.type === "stopped" || event.type === "exit"
            );
            return {
              exitCode: stopped?.exit_code ?? null,
            };
          },
        ),
    ),
    restartService: method(
      "Restart the named service on every Sprite the selector matches; each Sprite's outcome is also saved as restartService-<service_name>-<sprite>",
      z.object({
        select: SpriteSelector,
        service_name: z.string().min(1),
        duration: z.string().min(1).optional(),
      }),
      "restartService",
      summarySchema(serviceExitExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteRestartService",
          `restartService-${args.service_name}`,
          serviceExitExtra,
          async (sprite) => {
            const path = spritePath(
              sprite.name,
              `/services/${segment(args.service_name)}`,
            );
            const { events } = await serviceStream(
              context,
              "POST",
              `${path}/restart`,
              { query: { duration: args.duration } },
              "progress",
            );
            const exited = events.find((event) => event.type === "exit");
            if (exited) {
              return {
                failed: `exited during startup with code ${exited.exit_code}`,
                exitCode: exited.exit_code,
              };
            }
            await jsonRequest(context, "GET", path, Service);
            return { exitCode: null };
          },
        ),
    ),
    deleteService: method(
      "Delete the named service on every Sprite the selector matches; each Sprite's outcome is also saved as deleteService-<service_name>-<sprite>",
      z.object({ select: SpriteSelector, service_name: z.string().min(1) }),
      "deleteService",
      summarySchema(emptyExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteDeleteService",
          `deleteService-${args.service_name}`,
          emptyExtra,
          async (sprite) => {
            const path = spritePath(
              sprite.name,
              `/services/${segment(args.service_name)}`,
            );
            try {
              await emptyRequest(context, "DELETE", path);
            } catch (error) {
              if (context.signal.aborted) throw error;
              if (
                !(error instanceof ApiError && error.status === 404)
              ) throw error;
            }
            return {};
          },
        ),
    ),
    ...connectorsMethods,
  };
}
