// SPDX-License-Identifier: MIT

/**
 * The Fly organization the token belongs to.
 * The model keeps API credentials out of stored data and preserves API Sprite
 * fields for other models to read with CEL expressions.
 *
 * @module
 */

import { z } from "zod";
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

function policyExtra<P extends z.ZodObject>(Policy: P) {
  return z.object({
    action: z.enum(["set", "delete", "read"]),
    policy: Policy.nullable(),
  }).partial();
}

const network = policyExtra(NetworkPolicy);
const privileges = policyExtra(PrivilegesPolicy);
const resources = policyExtra(ResourcesPolicy);
const upgradeExtra = z.object({ version: z.string().nullable().optional() });
const restartExtra = z.object({});

const checkpointExtra = z.object({ checkpoint: Checkpoint.nullable() })
  .partial();
const serviceExtra = z.object({
  action: z.enum(["put", "start", "stop", "restart", "delete"]),
  exitCode: z.number().int().nullable(),
  service: Service.nullable(),
}).partial();

const execExtra = z.object({
  exitCode: z.number().int().nullable(),
  stdoutBytes: z.number().int().nonnegative().nullable(),
  stderrBytes: z.number().int().nonnegative().nullable(),
}).partial();
const ExecRollout = summarySchema(execExtra).extend({
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
  files: { stdout: BinaryFile, stderr: BinaryFile },
  resources: {
    spriteExec: resource(
      recordSchema(execExtra),
      "One Sprite’s command outcome; instance name exec-<sprite>",
    ),
    execRollout: resource(
      ExecRollout,
      "Outcomes of the last organization commands",
    ),
    ...connectorsResources,
    spriteCheckpoint: resource(
      recordSchema(checkpointExtra),
      "One Sprite's latest checkpoint outcome; instance name checkpoint-<sprite>",
    ),
    checkpointRollout: resource(
      summarySchema(checkpointExtra),
      "Outcomes of the last organization checkpoint requests",
    ),
    spriteService: resource(
      recordSchema(serviceExtra),
      "One Sprite's latest service outcome; instance name service-<service_name>-<sprite>",
    ),
    serviceRollout: resource(
      summarySchema(serviceExtra),
      "Outcomes of the last organization service requests",
    ),
    spriteUpgrade: resource(
      recordSchema(upgradeExtra),
      "One Sprite's latest runtime upgrade acceptance; instance name upgrade-<sprite>",
    ),
    upgradeRollout: resource(
      summarySchema(upgradeExtra),
      "Outcomes of the last organization runtime upgrade requests",
    ),
    spriteRestart: resource(
      recordSchema(restartExtra),
      "One Sprite's latest restart acceptance; instance name restart-<sprite>",
    ),
    restartRollout: resource(
      summarySchema(restartExtra),
      "Outcomes of the last organization restart requests",
    ),
    resourcesPolicyAudit: resource(
      summarySchema(resources),
      "Every selected Sprite's current resources policy as read by the organization",
    ),

    privilegesPolicyAudit: resource(
      summarySchema(privileges),
      "Every selected Sprite's current privileges policy as read by the organization",
    ),

    networkPolicyAudit: resource(
      summarySchema(network),
      "Every selected Sprite's current network policy as read by the organization",
    ),

    networkPolicyRollout: resource(
      summarySchema(policyExtra(NetworkPolicy)),
      "Which Sprites the last network policy rollout matched, set or removed on, and failed on",
    ),
    spriteNetworkPolicy: resource(
      recordSchema(network),
      "The organization's latest knowledge of one Sprite's network policy from a set, removal, or read; instance name networkPolicy-<sprite>",
    ),
    privilegesPolicyRollout: resource(
      summarySchema(policyExtra(PrivilegesPolicy)),
      "Which Sprites the last privileges policy rollout matched, set or removed on, and failed on",
    ),
    spritePrivilegesPolicy: resource(
      recordSchema(privileges),
      "The organization's latest knowledge of one Sprite's privileges policy from a set, removal, or read; instance name privilegesPolicy-<sprite>",
    ),
    resourcesPolicyRollout: resource(
      summarySchema(policyExtra(ResourcesPolicy)),
      "Which Sprites the last resources policy rollout matched, set or removed on, and failed on",
    ),
    spriteResourcesPolicy: resource(
      recordSchema(resources),
      "The organization's latest knowledge of one Sprite's resources policy from a set, removal, or read; instance name resourcesPolicy-<sprite>",
    ),
    sprites: resource(
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
      "Run one command on every Sprite the selector matches over HTTP exec; a nonzero exit is recorded, not failed; stdout and stderr are saved per Sprite as stdout-<sprite> and stderr-<sprite>",
      CommandArgs.omit({ failOnNonZero: true }).extend({
        select: SpriteSelector,
      }),
      "execRollout",
      ExecRollout,
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
              "stdout",
              `stdout-${sprite.name}`,
            ).writeAll(result.stdout);
            const stderr = await context.createFileWriter(
              "stderr",
              `stderr-${sprite.name}`,
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
      "sprites",
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
      "Replace the network policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as networkPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: NetworkPolicy }),
      "networkPolicyRollout",
      summarySchema(policyExtra(NetworkPolicy)),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteNetworkPolicy",
          "networkPolicy",
          network,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/policy/network"),
              { json: args.policy },
            );
            return { action: "set" as const, policy: args.policy };
          },
        ),
    ),
    setPrivilegesPolicy: method(
      "Set the privileges policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as privilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: PrivilegesPolicy }),
      "privilegesPolicyRollout",
      summarySchema(policyExtra(PrivilegesPolicy)),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spritePrivilegesPolicy",
          "privilegesPolicy",
          privileges,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/policy/privileges"),
              { json: args.policy },
            );
            return { action: "set" as const, policy: args.policy };
          },
        ),
    ),
    setResourcesPolicy: method(
      "Set the resources policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as resourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: ResourcesPolicy }),
      "resourcesPolicyRollout",
      summarySchema(policyExtra(ResourcesPolicy)),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteResourcesPolicy",
          "resourcesPolicy",
          resources,
          async (sprite) => {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/policy/resources"),
              { json: args.policy },
            );
            return { action: "set" as const, policy: args.policy };
          },
        ),
    ),
    deletePrivilegesPolicy: method(
      "Remove the privileges policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as privilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "privilegesPolicyRollout",
      summarySchema(policyExtra(PrivilegesPolicy)),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spritePrivilegesPolicy",
          "privilegesPolicy",
          privileges,
          async (sprite) => {
            await emptyRequest(
              context,
              "DELETE",
              spritePath(sprite.name, "/policy/privileges"),
            );
            return { action: "delete" as const, policy: null };
          },
        ),
    ),
    deleteResourcesPolicy: method(
      "Remove the resources policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as resourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "resourcesPolicyRollout",
      summarySchema(policyExtra(ResourcesPolicy)),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteResourcesPolicy",
          "resourcesPolicy",
          resources,
          async (sprite) => {
            await emptyRequest(
              context,
              "DELETE",
              spritePath(sprite.name, "/policy/resources"),
            );
            return { action: "delete" as const, policy: null };
          },
        ),
    ),
    getNetworkPolicy: method(
      "Read the network policy from every Sprite the selector matches; each Sprite's outcome is also saved as networkPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "networkPolicyAudit",
      summarySchema(network),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteNetworkPolicy",
          "networkPolicy",
          network,
          async (sprite) => {
            const policy = await jsonRequest(
              context,
              "GET",
              spritePath(sprite.name, "/policy/network"),
              NetworkPolicy,
            );
            return { action: "read" as const, policy };
          },
        ),
    ),
    getPrivilegesPolicy: method(
      "Read the privileges policy from every Sprite the selector matches; each Sprite's outcome is also saved as privilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "privilegesPolicyAudit",
      summarySchema(privileges),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spritePrivilegesPolicy",
          "privilegesPolicy",
          privileges,
          async (sprite) => {
            const policy = await jsonRequest(
              context,
              "GET",
              spritePath(sprite.name, "/policy/privileges"),
              PrivilegesPolicy,
            );
            return { action: "read" as const, policy };
          },
        ),
    ),
    getResourcesPolicy: method(
      "Read the resources policy from every Sprite the selector matches; each Sprite's outcome is also saved as resourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "resourcesPolicyAudit",
      summarySchema(resources),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteResourcesPolicy",
          "resourcesPolicy",
          resources,
          async (sprite) => {
            const policy = await jsonRequest(
              context,
              "GET",
              spritePath(sprite.name, "/policy/resources"),
              ResourcesPolicy,
            );
            return { action: "read" as const, policy };
          },
        ),
    ),
    // Not in either API reference; verified live.
    upgrade: method(
      "Request a runtime upgrade on every Sprite the selector matches; success only records provider acceptance",
      z.object({ select: SpriteSelector, version: z.string().optional() }),
      "upgradeRollout",
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
      "restartRollout",
      summarySchema(restartExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteRestart",
          "restart",
          restartExtra,
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
      "Take a checkpoint on every Sprite the selector matches; each Sprite's outcome is also saved as checkpoint-<sprite>",
      z.object({ select: SpriteSelector, comment: z.string().optional() }),
      "checkpointRollout",
      summarySchema(checkpointExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteCheckpoint",
          "checkpoint",
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
      "Create or update the named service on every Sprite the selector matches; each Sprite's outcome is also saved as service-<service_name>-<sprite>",
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
      "serviceRollout",
      summarySchema(serviceExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteService",
          `service-${args.service_name}`,
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
                action: "put" as const,
                exitCode: exited.exit_code,
                service: null,
              };
            }
            const service = await jsonRequest(context, "GET", path, Service);
            return { action: "put" as const, exitCode: null, service };
          },
        ),
    ),
    startService: method(
      "Start the named service on every Sprite the selector matches; each Sprite's outcome is also saved as service-<service_name>-<sprite>",
      z.object({
        select: SpriteSelector,
        service_name: z.string().min(1),
        duration: z.string().min(1).optional(),
      }),
      "serviceRollout",
      summarySchema(serviceExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteService",
          `service-${args.service_name}`,
          serviceExtra,
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
                action: "start" as const,
                exitCode: exited.exit_code,
                service: null,
              };
            }
            const service = await jsonRequest(context, "GET", path, Service);
            return { action: "start" as const, exitCode: null, service };
          },
        ),
    ),
    stopService: method(
      "Stop the named service on every Sprite the selector matches; each Sprite's outcome is also saved as service-<service_name>-<sprite>",
      z.object({
        select: SpriteSelector,
        service_name: z.string().min(1),
        timeout: z.string().min(1).optional(),
      }),
      "serviceRollout",
      summarySchema(serviceExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteService",
          `service-${args.service_name}`,
          serviceExtra,
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
              action: "stop" as const,
              exitCode: stopped?.exit_code ?? null,
              service: null,
            };
          },
        ),
    ),
    restartService: method(
      "Restart the named service on every Sprite the selector matches; each Sprite's outcome is also saved as service-<service_name>-<sprite>",
      z.object({
        select: SpriteSelector,
        service_name: z.string().min(1),
        duration: z.string().min(1).optional(),
      }),
      "serviceRollout",
      summarySchema(serviceExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteService",
          `service-${args.service_name}`,
          serviceExtra,
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
                action: "restart" as const,
                exitCode: exited.exit_code,
                service: null,
              };
            }
            const service = await jsonRequest(context, "GET", path, Service);
            return { action: "restart" as const, exitCode: null, service };
          },
        ),
    ),
    deleteService: method(
      "Delete the named service on every Sprite the selector matches; each Sprite's outcome is also saved as service-<service_name>-<sprite>",
      z.object({ select: SpriteSelector, service_name: z.string().min(1) }),
      "serviceRollout",
      summarySchema(serviceExtra),
      (args, context: Context) =>
        fanOut(
          context,
          args.select,
          "spriteService",
          `service-${args.service_name}`,
          serviceExtra,
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
            return { action: "delete" as const, exitCode: null, service: null };
          },
        ),
    ),
    ...connectorsMethods,
  };
}
