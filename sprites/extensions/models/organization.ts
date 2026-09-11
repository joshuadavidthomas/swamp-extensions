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
  type Context,
  emptyRequest,
  inputBytes,
  jsonRequest,
  runMethod,
  segment,
  withHandles,
} from "./_lib/core.ts";
import { Checkpoint, checkpointStream } from "./_lib/checkpoints.ts";
import { envPairs, executeHttp } from "./_lib/exec.ts";
import { type ManagementExec } from "./_lib/local-api.ts";
import { Service, serviceStream } from "./_lib/services.ts";
import { ConnectionsResponseSchema } from "./_lib/connectors.ts";
import {
  NetworkPolicy,
  PrivilegesPolicy,
  ResourcesPolicy,
} from "./_lib/policy.ts";
import { spritePath, SpriteResponse } from "./_lib/sprite.ts";
import {
  fanOut,
  listAllSprites,
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
type OrganizationContext = Context & { managementExec?: ManagementExec };
function methodDescription(name: string): string {
  const methods: Record<string, { description: string }> = model.methods;
  return methods[name].description;
}
type OrganizationExecInput = {
  cmd: string[];
  path?: string;
  dir?: string;
  env?: Record<string, string>;
  input?:
    | { kind: "text"; text: string }
    | { kind: "base64"; base64: string };
  select: z.output<typeof SpriteSelector>;
};

const network = z.object({ policy: NetworkPolicy.nullable().optional() });
const privileges = z.object({ policy: PrivilegesPolicy.nullable().optional() });
const resources = z.object({ policy: ResourcesPolicy.nullable().optional() });
const upgradeExtra = z.object({ version: z.string().nullable().optional() });
const emptyExtra = z.object({});
const checkpointExtra = z.object({
  checkpoint: Checkpoint.nullable().optional(),
});
const serviceExtra = z.object({
  serviceName: z.string(),
  exitCode: z.number().int().nullable().optional(),
  service: Service.nullable().optional(),
});
const serviceExitExtra = z.object({
  serviceName: z.string(),
  exitCode: z.number().int().nullable().optional(),
});
const serviceDeleteExtra = z.object({ serviceName: z.string() });
const execExtra = z.object({
  exitCode: z.number().int().nullable(),
  stdoutBytes: z.number().int().nonnegative().nullable(),
  stderrBytes: z.number().int().nonnegative().nullable(),
}).partial();
const ExecSummary = summarySchema(execExtra).extend({
  nonzero: z.number().int().nonnegative(),
});

/** Run organization exec through an injectable HTTP exec transport. */
async function executeOrganizationExec(
  args: OrganizationExecInput,
  context: OrganizationContext,
  execute: ManagementExec,
) {
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
        `execStdout-${sprite.id}`,
      ).writeAll(result.stdout);
      const stderr = await context.createFileWriter(
        "spriteExecStderr",
        `execStderr-${sprite.id}`,
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
}

/** The Fly organization the token belongs to: its Sprites and its connections. */
export const model = {
  type: "@josh/sprites/organization",
  version: "2026.09.11.1",
  globalArguments: z.object({
    token: z.string().meta({ sensitive: true }).min(1).regex(
      /^[\x21-\x7e]+$/,
      "Use a bearer token without spaces or control characters.",
    ).describe("Organization token; use a vault reference."),
    baseUrl: z.url({ protocol: /^https$/, error: "Use an HTTPS API endpoint." })
      .optional().default("https://api.sprites.dev"),
    timeoutMs: z.number().int().min(1).max(2147483647).optional().default(
      30000,
    ),
    maxResponseBytes: z.number().int().min(1).max(1073741824).optional()
      .default(67108864),
  }),
  files: {
    spriteExecStdout: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
    spriteExecStderr: {
      description: "Operation bytes; may contain application secrets",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  resources: {
    listConnectors: {
      schema: z.object({
        connections: z.array(z.object({
          id: z.string(),
          provider: z.enum([
            "slack",
            "slack_bot",
            "github",
            "discourse",
            "openrouter",
            "ollama",
            "anthropic",
            "s3_object_store",
            "custom_api",
            "sprites_admin",
          ]),
          provider_account_id: z.string(),
          provider_account_name: z.string().optional(),
          scopes: z.string().nullish(),
          connection_type: z.enum([
            "oauth",
            "api_key",
            "provisioned",
            "internal",
          ]).optional(),
          access_policy: z.object({
            allow_all: z.boolean().optional().describe(
              "Grant every Sprite access; this overrides sprite_labels and name_prefix.",
            ),
            sprite_labels: z.array(z.string()).optional().describe(
              "Require every listed Sprite label.",
            ),
            name_prefix: z.string().optional().describe(
              "Require Sprite names to start with this prefix.",
            ),
            allowed_endpoints: z.array(z.string()).optional(),
            blocked_endpoints: z.array(z.string()).optional().describe(
              "Provider paths denied before allowed_endpoints are evaluated.",
            ),
          }).describe(
            "Complete connector access policy. An empty policy denies every Sprite.",
          ).optional(),
          provider_info: z.record(z.string(), z.json()).optional(),
          user_id: z.string().nullish(),
          token_expires_at: z.iso.datetime({ offset: true }).meta({
            sensitive: false,
          }).nullish(),
          inserted_at: z.iso.datetime({ offset: true }).optional(),
          updated_at: z.iso.datetime({ offset: true }).optional(),
          usage_snippet: z.string().optional(),
        })),
      }),
      description: "Complete organization connector collection",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    setNetworkPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          policy: z.object({
            rules: z.array(
              z.object({
                domain: z.string().optional(),
                action: z.enum(["allow", "deny"]).optional(),
                include: z.string().optional(),
              }).refine(
                (rule) =>
                  !(rule.domain !== undefined && rule.include !== undefined),
                {
                  message:
                    "A network rule cannot contain both domain and include.",
                },
              ),
            ),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last setNetworkPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteSetNetworkPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        policy: z.object({
          rules: z.array(
            z.object({
              domain: z.string().optional(),
              action: z.enum(["allow", "deny"]).optional(),
              include: z.string().optional(),
            }).refine(
              (rule) =>
                !(rule.domain !== undefined && rule.include !== undefined),
              {
                message:
                  "A network rule cannot contain both domain and include.",
              },
            ),
          ),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of setNetworkPolicy; instance name setNetworkPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    setPrivilegesPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          policy: z.object({
            profile: z.enum(["", "minimal", "standard", "privileged"])
              .optional(),
            devices: z.array(z.string()).optional(),
            noNewPrivileges: z.boolean().optional(),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last setPrivilegesPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteSetPrivilegesPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        policy: z.object({
          profile: z.enum(["", "minimal", "standard", "privileged"]).optional(),
          devices: z.array(z.string()).optional(),
          noNewPrivileges: z.boolean().optional(),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of setPrivilegesPolicy; instance name setPrivilegesPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    setResourcesPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          policy: z.object({
            memory: z.object({
              limit_mb: z.number().positive(),
              autoscale: z.boolean().optional(),
            }).optional(),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last setResourcesPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteSetResourcesPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        policy: z.object({
          memory: z.object({
            limit_mb: z.number().positive(),
            autoscale: z.boolean().optional(),
          }).optional(),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of setResourcesPolicy; instance name setResourcesPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deletePrivilegesPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last deletePrivilegesPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteDeletePrivilegesPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of deletePrivilegesPolicy; instance name deletePrivilegesPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deleteResourcesPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last deleteResourcesPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteDeleteResourcesPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of deleteResourcesPolicy; instance name deleteResourcesPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    getNetworkPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          policy: z.object({
            rules: z.array(
              z.object({
                domain: z.string().optional(),
                action: z.enum(["allow", "deny"]).optional(),
                include: z.string().optional(),
              }).refine(
                (rule) =>
                  !(rule.domain !== undefined && rule.include !== undefined),
                {
                  message:
                    "A network rule cannot contain both domain and include.",
                },
              ),
            ),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last getNetworkPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteGetNetworkPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        policy: z.object({
          rules: z.array(
            z.object({
              domain: z.string().optional(),
              action: z.enum(["allow", "deny"]).optional(),
              include: z.string().optional(),
            }).refine(
              (rule) =>
                !(rule.domain !== undefined && rule.include !== undefined),
              {
                message:
                  "A network rule cannot contain both domain and include.",
              },
            ),
          ),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of getNetworkPolicy; instance name getNetworkPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    getPrivilegesPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          policy: z.object({
            profile: z.enum(["", "minimal", "standard", "privileged"])
              .optional(),
            devices: z.array(z.string()).optional(),
            noNewPrivileges: z.boolean().optional(),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last getPrivilegesPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteGetPrivilegesPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        policy: z.object({
          profile: z.enum(["", "minimal", "standard", "privileged"]).optional(),
          devices: z.array(z.string()).optional(),
          noNewPrivileges: z.boolean().optional(),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of getPrivilegesPolicy; instance name getPrivilegesPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    getResourcesPolicy: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          policy: z.object({
            memory: z.object({
              limit_mb: z.number().positive(),
              autoscale: z.boolean().optional(),
            }).optional(),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last getResourcesPolicy run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteGetResourcesPolicy: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        policy: z.object({
          memory: z.object({
            limit_mb: z.number().positive(),
            autoscale: z.boolean().optional(),
          }).optional(),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of getResourcesPolicy; instance name getResourcesPolicy-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    upgrade: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          version: z.string().nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last upgrade run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteUpgrade: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        version: z.string().nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of upgrade; instance name upgrade-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    restart: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last restart run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteRestart: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of restart; instance name restart-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    createCheckpoint: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          checkpoint: z.object({
            id: z.string(),
            create_time: z.iso.datetime({ offset: true }),
            comment: z.string().optional(),
            health: z.string().optional(),
            source_id: z.string().optional(),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last createCheckpoint run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteCreateCheckpoint: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        checkpoint: z.object({
          id: z.string(),
          create_time: z.iso.datetime({ offset: true }),
          comment: z.string().optional(),
          health: z.string().optional(),
          source_id: z.string().optional(),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of createCheckpoint; instance name createCheckpoint-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    putService: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          serviceName: z.string(),
          exitCode: z.number().int().nullable().optional(),
          service: z.object({
            name: z.string(),
            cmd: z.string(),
            args: z.array(z.string()).nullable(),
            env: z.record(z.string(), z.string()).meta({
              sensitive: true,
            }).optional(),
            dir: z.string().optional(),
            needs: z.array(z.string()).nullable(),
            http_port: z.number().int().nullable().optional(),
            state: z.object({
              name: z.string(),
              status: z.enum([
                "stopped",
                "starting",
                "running",
                "stopping",
                "failed",
              ]),
              pid: z.number().int().optional(),
              started_at: z.string().optional(),
              error: z.string().optional(),
              restart_count: z.number().int().nonnegative().optional(),
              next_restart_at: z.string().optional(),
            }).nullish(),
          }).nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last putService run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spritePutService: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        serviceName: z.string(),
        exitCode: z.number().int().nullable().optional(),
        service: z.object({
          name: z.string(),
          cmd: z.string(),
          args: z.array(z.string()).nullable(),
          env: z.record(z.string(), z.string()).meta({
            sensitive: true,
          }).optional(),
          dir: z.string().optional(),
          needs: z.array(z.string()).nullable(),
          http_port: z.number().int().nullable().optional(),
          state: z.object({
            name: z.string(),
            status: z.enum([
              "stopped",
              "starting",
              "running",
              "stopping",
              "failed",
            ]),
            pid: z.number().int().optional(),
            started_at: z.string().optional(),
            error: z.string().optional(),
            restart_count: z.number().int().nonnegative().optional(),
            next_restart_at: z.string().optional(),
          }).nullish(),
        }).nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of putService; instance name putService-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    startService: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          serviceName: z.string(),
          exitCode: z.number().int().nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last startService run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteStartService: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        serviceName: z.string(),
        exitCode: z.number().int().nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of startService; instance name startService-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    stopService: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          serviceName: z.string(),
          exitCode: z.number().int().nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last stopService run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteStopService: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        serviceName: z.string(),
        exitCode: z.number().int().nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of stopService; instance name stopService-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    restartService: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          serviceName: z.string(),
          exitCode: z.number().int().nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last restartService run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteRestartService: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        serviceName: z.string(),
        exitCode: z.number().int().nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of restartService; instance name restartService-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deleteService: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          serviceName: z.string(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "Last deleteService run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteDeleteService: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        serviceName: z.string(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of deleteService; instance name deleteService-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    exec: {
      schema: z.object({
        select: z.object({
          all: z.literal(true).optional(),
          prefix: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
        matched: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        results: z.array(z.object({
          name: z.string(),
          id: z.string(),
          status: z.enum(["applied", "failed"]),
          error: z.string().optional(),
          exitCode: z.number().int().nullable().optional(),
          stdoutBytes: z.number().int().nonnegative().nullable().optional(),
          stderrBytes: z.number().int().nonnegative().nullable().optional(),
        })),
        observedAt: z.iso.datetime({ offset: true }),
        nonzero: z.number().int().nonnegative(),
      }),
      description:
        "Last exec run: which Sprites it matched, applied to, and failed on",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    spriteExec: {
      schema: z.object({
        name: z.string(),
        id: z.string(),
        status: z.enum(["applied", "failed"]),
        error: z.string().optional(),
        exitCode: z.number().int().nullable().optional(),
        stdoutBytes: z.number().int().nonnegative().nullable().optional(),
        stderrBytes: z.number().int().nonnegative().nullable().optional(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description:
        "One Sprite's outcome of exec; instance name exec-<sprite-id>",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    listSprites: {
      schema: z.object({
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
        sprites: z.array(z.object({
          id: z.string(),
          name: z.string(),
          organization: z.string(),
          url: z.string(),
          status: z.enum(["cold", "warm", "running"]),
          created_at: z.iso.datetime({ offset: true }),
          updated_at: z.iso.datetime({ offset: true }),
          url_settings: z.object({
            auth: z.enum(["sprite", "public"]),
            private_access: z.enum(["admins", "org_users"]).optional(),
          }).nullish(),
          version: z.string().nullish(),
          environment_version: z.string().nullish(),
          labels: z.array(z.string()).optional(),
          last_running_at: z.iso.datetime({ offset: true }).nullish(),
          last_warming_at: z.iso.datetime({ offset: true }).nullish(),
        })),
        prefix: z.string().nullable(),
        observedAt: z.iso.datetime({ offset: true }),
      }),
      description: "Current Sprites and capacity limits for one organization",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    exec: {
      description:
        "Run one command on every Sprite the selector matches over HTTP exec; a nonzero exit is recorded, not failed; stdout and stderr are saved per Sprite as execStdout-<sprite-id> and execStderr-<sprite-id>",
      arguments: z.object({
        cmd: z.array(z.string()).min(1).describe(
          "Program and argv, encoded as repeated cmd parameters.",
        ),
        path: z.string().optional(),
        dir: z.string().optional(),
        env: z.record(z.string(), z.string()).optional().meta({
          sensitive: true,
        }),
        input: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("text"), text: z.string() }),
          z.object({ kind: z.literal("base64"), base64: z.base64() }),
        ]).optional().meta({ sensitive: true }),
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
      }),
      execute: (
        args: OrganizationExecInput,
        context: OrganizationContext,
      ) =>
        runMethod(
          context,
          methodDescription("exec"),
          "exec",
          ExecSummary,
          () =>
            executeOrganizationExec(
              args,
              context,
              context.managementExec ?? executeHttp,
            ),
        ),
    },
    listSprites: {
      description: "Read every Sprite visible to the organization token",
      arguments: z.object({
        prefix: z.string().min(1).optional().describe(
          "Only include Sprite names with this prefix.",
        ),
      }),
      execute: (args: { prefix?: string }, context: Context) =>
        runMethod(
          context,
          methodDescription("listSprites"),
          "listSprites",
          InventorySchema,
          async () => {
            const budget = { remaining: context.globalArgs.maxResponseBytes };
            const { organization, sprites } = await listAllSprites(
              context,
              args,
              budget,
            );
            const statusCounts = { running: 0, warm: 0, cold: 0 };
            for (const sprite of sprites) statusCounts[sprite.status] += 1;
            const inventory = {
              organization,
              counts: { total: sprites.length, ...statusCounts },
              sprites,
              prefix: args.prefix ?? null,
              observedAt: new Date().toISOString(),
            };
            context.logger.info(
              "Read {count} Sprites for organization {name}",
              {
                count: inventory.counts.total,
                name: inventory.organization.name,
              },
            );
            return inventory;
          },
        ),
    },
    setNetworkPolicy: {
      description:
        "Replace the network policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as setNetworkPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        policy: z.object({
          rules: z.array(
            z.object({
              domain: z.string().optional(),
              action: z.enum(["allow", "deny"]).optional(),
              include: z.string().optional(),
            }).refine(
              (rule) =>
                !(rule.domain !== undefined && rule.include !== undefined),
              {
                message:
                  "A network rule cannot contain both domain and include.",
              },
            ),
          ),
        }),
      }),
      execute: (
        args: {
          select: z.output<typeof SpriteSelector>;
          policy: z.output<typeof NetworkPolicy>;
        },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("setNetworkPolicy"),
          "setNetworkPolicy",
          summarySchema(network),
          () =>
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
    },
    setPrivilegesPolicy: {
      description:
        "Set the privileges policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as setPrivilegesPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        policy: z.object({
          profile: z.enum(["", "minimal", "standard", "privileged"]).optional(),
          devices: z.array(z.string()).optional(),
          noNewPrivileges: z.boolean().optional(),
        }),
      }),
      execute: (
        args: {
          select: z.output<typeof SpriteSelector>;
          policy: z.output<typeof PrivilegesPolicy>;
        },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("setPrivilegesPolicy"),
          "setPrivilegesPolicy",
          summarySchema(privileges),
          () =>
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
    },
    setResourcesPolicy: {
      description:
        "Set the resources policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as setResourcesPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        policy: z.object({
          memory: z.object({
            limit_mb: z.number().positive(),
            autoscale: z.boolean().optional(),
          }).optional(),
        }),
      }),
      execute: (
        args: {
          select: z.output<typeof SpriteSelector>;
          policy: z.output<typeof ResourcesPolicy>;
        },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("setResourcesPolicy"),
          "setResourcesPolicy",
          summarySchema(resources),
          () =>
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
    },
    deletePrivilegesPolicy: {
      description:
        "Remove the privileges policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as deletePrivilegesPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector> },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("deletePrivilegesPolicy"),
          "deletePrivilegesPolicy",
          summarySchema(emptyExtra),
          () =>
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
    },
    deleteResourcesPolicy: {
      description:
        "Remove the resources policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as deleteResourcesPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector> },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("deleteResourcesPolicy"),
          "deleteResourcesPolicy",
          summarySchema(emptyExtra),
          () =>
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
    },
    getNetworkPolicy: {
      description:
        "Read the network policy from every Sprite the selector matches; each Sprite's outcome is also saved as getNetworkPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector> },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("getNetworkPolicy"),
          "getNetworkPolicy",
          summarySchema(network),
          () =>
            fanOut(
              context,
              args.select,
              "spriteGetNetworkPolicy",
              "getNetworkPolicy",
              network,
              async (sprite) => ({
                policy: await jsonRequest(
                  context,
                  "GET",
                  spritePath(sprite.name, "/policy/network"),
                  NetworkPolicy,
                ),
              }),
            ),
        ),
    },
    getPrivilegesPolicy: {
      description:
        "Read the privileges policy from every Sprite the selector matches; each Sprite's outcome is also saved as getPrivilegesPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector> },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("getPrivilegesPolicy"),
          "getPrivilegesPolicy",
          summarySchema(privileges),
          () =>
            fanOut(
              context,
              args.select,
              "spriteGetPrivilegesPolicy",
              "getPrivilegesPolicy",
              privileges,
              async (sprite) => ({
                policy: await jsonRequest(
                  context,
                  "GET",
                  spritePath(sprite.name, "/policy/privileges"),
                  PrivilegesPolicy,
                ),
              }),
            ),
        ),
    },
    getResourcesPolicy: {
      description:
        "Read the resources policy from every Sprite the selector matches; each Sprite's outcome is also saved as getResourcesPolicy-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector> },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("getResourcesPolicy"),
          "getResourcesPolicy",
          summarySchema(resources),
          () =>
            fanOut(
              context,
              args.select,
              "spriteGetResourcesPolicy",
              "getResourcesPolicy",
              resources,
              async (sprite) => ({
                policy: await jsonRequest(
                  context,
                  "GET",
                  spritePath(sprite.name, "/policy/resources"),
                  ResourcesPolicy,
                ),
              }),
            ),
        ),
    },
    upgrade: {
      description:
        "Request a runtime upgrade on every Sprite the selector matches; success only records provider acceptance; each Sprite's outcome is also saved as upgrade-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        version: z.string().optional(),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector>; version?: string },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("upgrade"),
          "upgrade",
          summarySchema(upgradeExtra),
          () =>
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
    },
    restart: {
      description:
        "Request a restart on every Sprite the selector matches; success only records provider acceptance; each Sprite's outcome is also saved as restart-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector> },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("restart"),
          "restart",
          summarySchema(emptyExtra),
          () =>
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
    },
    createCheckpoint: {
      description:
        "Take a checkpoint on every Sprite the selector matches; each Sprite's outcome is also saved as createCheckpoint-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        comment: z.string().optional(),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector>; comment?: string },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("createCheckpoint"),
          "createCheckpoint",
          summarySchema(checkpointExtra),
          () =>
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
    },
    putService: {
      description:
        "Create or update the named service on every Sprite the selector matches; each Sprite's outcome is also saved as putService-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        service_name: z.string().min(1),
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
          select: z.output<typeof SpriteSelector>;
          service_name: string;
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
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("putService"),
          "putService",
          summarySchema(serviceExtra),
          () =>
            fanOut(
              context,
              args.select,
              "spritePutService",
              "putService",
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
                    failed:
                      `exited during startup with code ${exited.exit_code}`,
                    exitCode: exited.exit_code,
                    service: null,
                  };
                }
                return {
                  exitCode: null,
                  service: await jsonRequest(context, "GET", path, Service),
                };
              },
              { serviceName: args.service_name },
            ),
        ),
    },
    startService: {
      description:
        "Start the named service on every Sprite the selector matches; each Sprite's outcome is also saved as startService-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        service_name: z.string().min(1),
        duration: z.string().min(1).optional(),
      }),
      execute: (
        args: {
          select: z.output<typeof SpriteSelector>;
          service_name: string;
          duration?: string;
        },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("startService"),
          "startService",
          summarySchema(serviceExitExtra),
          () =>
            fanOut(
              context,
              args.select,
              "spriteStartService",
              "startService",
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
                    failed:
                      `exited during startup with code ${exited.exit_code}`,
                    exitCode: exited.exit_code,
                  };
                }
                await jsonRequest(context, "GET", path, Service);
                return { exitCode: null };
              },
              { serviceName: args.service_name },
            ),
        ),
    },
    stopService: {
      description:
        "Stop the named service on every Sprite the selector matches; each Sprite's outcome is also saved as stopService-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        service_name: z.string().min(1),
        timeout: z.string().min(1).optional(),
      }),
      execute: (
        args: {
          select: z.output<typeof SpriteSelector>;
          service_name: string;
          timeout?: string;
        },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("stopService"),
          "stopService",
          summarySchema(serviceExitExtra),
          () =>
            fanOut(
              context,
              args.select,
              "spriteStopService",
              "stopService",
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
                return { exitCode: stopped?.exit_code ?? null };
              },
              { serviceName: args.service_name },
            ),
        ),
    },
    restartService: {
      description:
        "Restart the named service on every Sprite the selector matches; each Sprite's outcome is also saved as restartService-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        service_name: z.string().min(1),
        duration: z.string().min(1).optional(),
      }),
      execute: (
        args: {
          select: z.output<typeof SpriteSelector>;
          service_name: string;
          duration?: string;
        },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("restartService"),
          "restartService",
          summarySchema(serviceExitExtra),
          () =>
            fanOut(
              context,
              args.select,
              "spriteRestartService",
              "restartService",
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
                    failed:
                      `exited during startup with code ${exited.exit_code}`,
                    exitCode: exited.exit_code,
                  };
                }
                await jsonRequest(context, "GET", path, Service);
                return { exitCode: null };
              },
              { serviceName: args.service_name },
            ),
        ),
    },
    deleteService: {
      description:
        "Delete the named service on every Sprite the selector matches; each Sprite's outcome is also saved as deleteService-<sprite-id>",
      arguments: z.object({
        select: z.object({
          all: z.literal(true).optional().describe(
            "Every Sprite in the organization.",
          ),
          prefix: z.string().min(1).optional().describe(
            "Sprites whose name starts with this.",
          ),
          labels: z.array(z.string().min(1)).min(1).optional().describe(
            "Sprites carrying every one of these labels.",
          ),
        }).refine(
          (select) =>
            select.all === true || select.prefix !== undefined ||
            select.labels !== undefined,
          {
            message: "Select Sprites with all, prefix, or labels.",
          },
        ).refine((select) =>
          !(select.all === true &&
            (select.prefix !== undefined || select.labels !== undefined)), {
          message: "all cannot be combined with prefix or labels.",
        }),
        service_name: z.string().min(1),
      }),
      execute: (
        args: { select: z.output<typeof SpriteSelector>; service_name: string },
        context: Context,
      ) =>
        runMethod(
          context,
          methodDescription("deleteService"),
          "deleteService",
          summarySchema(serviceDeleteExtra),
          () =>
            fanOut(
              context,
              args.select,
              "spriteDeleteService",
              "deleteService",
              serviceDeleteExtra,
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
              { serviceName: args.service_name },
            ),
        ),
    },
    listConnectors: {
      description: "List organization connectors",
      arguments: z.object({ provider: z.string().optional() }),
      execute: (args: { provider?: string }, context: Context) =>
        runMethod(
          context,
          methodDescription("listConnectors"),
          "listConnectors",
          ConnectionsResponseSchema,
          () =>
            jsonRequest(
              context,
              "GET",
              "/v1/oauth/connections",
              ConnectionsResponseSchema,
              { query: { provider: args.provider } },
            ),
        ),
    },
  },
};
