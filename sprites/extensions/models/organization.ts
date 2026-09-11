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
  type Context,
  emptyRequest,
  InvalidResponseError,
  jsonRequest,
  method,
  resource,
  ResponseLimitError,
  withHandles,
} from "./_lib/core.ts";

import { connectorsMethods, connectorsResources } from "./_lib/connectors.ts";

import {
  NetworkPolicy,
  PrivilegesPolicy,
  ResourcesPolicy,
} from "./_lib/policy.ts";

import { spritePath, SpriteResponse } from "./_lib/sprite.ts";

const LookupArgsSchema = z.object({
  prefix: z.string().min(1).optional().describe(
    "Only include Sprite names with this prefix.",
  ),
});

const ApiPageSchema = z.object({
  sprites: z.array(SpriteResponse),
  has_more: z.boolean(),
  next_continuation_token: z.string().nullish(),
  name: z.string(),
  running_limit: z.number().int().nonnegative().optional(),
  warm_limit: z.number().int().nonnegative().optional(),
});

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

/** Which Sprites an organization-wide operation touches. Matching happens at call time; nothing is bound. */
const SpriteSelector = z.object({
  all: z.literal(true).optional().describe("Every Sprite in the organization."),
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
  { message: "Select Sprites with all, prefix, or labels." },
).refine(
  (select) =>
    !(select.all === true &&
      (select.prefix !== undefined || select.labels !== undefined)),
  { message: "all cannot be combined with prefix or labels." },
);
const RolloutResult = z.object({
  name: z.string(),
  id: z.string(),
  status: z.enum(["applied", "failed"]),
  error: z.string().optional(),
});
function rolloutSchemas<P extends z.ZodObject>(Policy: P) {
  const row = RolloutResult.extend({
    action: z.enum(["set", "delete"]),
    policy: Policy.nullable(),
    observedAt: z.iso.datetime({ offset: true }),
  });
  const summary = z.object({
    select: z.object({
      all: z.literal(true).optional(),
      prefix: z.string().optional(),
      labels: z.array(z.string()).optional(),
    }),
    action: z.enum(["set", "delete"]),
    policy: Policy.nullable(),
    matched: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    results: z.array(RolloutResult),
    observedAt: z.iso.datetime({ offset: true }),
  });
  return { row, summary };
}

const network = rolloutSchemas(NetworkPolicy);
const privileges = rolloutSchemas(PrivilegesPolicy);
const resources = rolloutSchemas(ResourcesPolicy);

const retryableStatuses = new Set([429, 502, 503, 504]);
const maxAttempts = 3;

function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = error instanceof ApiError ? error.retryAfter : null;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }

    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) {
      return Math.max(retryAt - Date.now(), 0);
    }
  }

  return 250 * 2 ** (attempt - 1);
}

function waitForRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function listSpritesPage(
  ctx: Context,
  args: z.infer<typeof LookupArgsSchema>,
  budget: { remaining: number },
  continuationToken?: string,
) {
  for (let attempt = 1;; attempt += 1) {
    try {
      return await jsonRequest(ctx, "GET", "/v1/sprites", ApiPageSchema, {
        query: {
          max_results: 500,
          prefix: args.prefix,
          continuation_token: continuationToken,
        },
        budget,
      });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      if (error instanceof ResponseLimitError) throw error;
      if (error instanceof InvalidResponseError) throw error;
      if (error instanceof ApiError && !retryableStatuses.has(error.status)) {
        throw error;
      }
      if (attempt === maxAttempts) throw error;
      const delay = retryDelayMs(error, attempt);
      if (delay > ctx.globalArgs.timeoutMs) {
        throw new Error(
          `Sprites API asked for a retry delay of ${delay}ms, longer than timeoutMs`,
          { cause: error },
        );
      }
      await waitForRetry(delay, ctx.signal);
    }
  }
}

/** Every Sprite the token can see, across pages, with the organization facts from the first page. */
async function listAllSprites(
  ctx: Context,
  args: z.infer<typeof LookupArgsSchema>,
  budget: { remaining: number },
): Promise<{
  organization: {
    name: string;
    runningLimit: number | null;
    warmLimit: number | null;
  };
  sprites: z.output<typeof SpriteResponse>[];
}> {
  const seenTokens = new Set<string>();
  let page = await listSpritesPage(ctx, args, budget);
  const organization = {
    name: page.name,
    runningLimit: page.running_limit ?? null,
    warmLimit: page.warm_limit ?? null,
  };
  const sprites = [...page.sprites];
  while (page.has_more) {
    const token = page.next_continuation_token;
    if (!token) {
      throw new Error(
        "Sprites API reported another page without a continuation token",
      );
    }
    if (seenTokens.has(token)) {
      throw new Error(
        "Sprites API repeated a continuation token while listing Sprites",
      );
    }
    seenTokens.add(token);
    page = await listSpritesPage(ctx, args, budget, token);
    sprites.push(...page.sprites);
  }
  return { organization, sprites };
}

/** Set or remove one policy on every selected Sprite, one at a time, recording each outcome as <kind>Policy-<sprite>. */
async function rolloutPolicy<P extends z.ZodObject>(
  context: Context,
  kind: "network" | "privileges" | "resources",
  action: "set" | "delete",
  Policy: P,
  select: z.output<typeof SpriteSelector>,
  policy: z.output<P> | null,
) {
  const { row: rowSchema } = rolloutSchemas(Policy);
  const specName = {
    network: "spriteNetworkPolicy",
    privileges: "spritePrivilegesPolicy",
    resources: "spriteResourcesPolicy",
  }[kind];
  const budget = { remaining: context.globalArgs.maxResponseBytes };
  const { sprites } = await listAllSprites(context, {
    prefix: select.prefix,
  }, budget);
  const wanted = select.labels ?? [];
  const matched = sprites.filter((sprite) =>
    wanted.every((label) => sprite.labels?.includes(label))
  );
  const results: z.input<typeof RolloutResult>[] = [];
  const handles = [];
  const observedAt = new Date().toISOString();
  for (const sprite of matched) {
    let row: z.input<typeof RolloutResult>;
    try {
      const path = spritePath(sprite.name, `/policy/${kind}`);
      if (action === "set") {
        await emptyRequest(context, "POST", path, { json: policy });
      } else {
        await emptyRequest(context, "DELETE", path);
      }
      row = {
        name: sprite.name,
        id: sprite.id,
        status: "applied",
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      row = {
        name: sprite.name,
        id: sprite.id,
        status: "failed",
        error: error instanceof ApiError
          ? `HTTP ${error.status}`
          : "request failed",
      };
    }
    results.push(row);
    handles.push(
      await context.writeResource(
        specName,
        `${kind}Policy-${sprite.name}`,
        rowSchema.parse({
          ...row,
          action,
          policy,
          observedAt,
        }),
      ),
    );
  }
  const applied =
    results.filter((result) => result.status === "applied").length;
  context.logger.info(
    action === "set"
      ? "Applied {kind} policy to {applied} of {matched} Sprites"
      : "Removed {kind} policy from {applied} of {matched} Sprites",
    { kind, applied, matched: matched.length },
  );
  const summary = {
    select,
    action,
    policy,
    matched: matched.length,
    applied,
    failed: matched.length - applied,
    results,
    observedAt,
  };
  return withHandles(summary, handles);
}

/** The Fly organization the token belongs to: its Sprites and its connections. */
export const model = {
  type: "@josh/sprites/organization",
  version: "2026.09.11.1",
  // Inventory allows 30 seconds per page, including larger organization lists.
  globalArguments: AuthSchema.extend({
    timeoutMs: AuthSchema.shape.timeoutMs.default(30_000),
  }),
  resources: {
    ...connectorsResources,
    networkPolicyRollout: resource(
      network.summary,
      "Which Sprites the last network policy rollout matched, set or removed on, and failed on",
    ),
    spriteNetworkPolicy: resource(
      network.row,
      "One Sprite's latest outcome from an organization network policy set or removal; instance name networkPolicy-<sprite>",
    ),
    privilegesPolicyRollout: resource(
      privileges.summary,
      "Which Sprites the last privileges policy rollout matched, set or removed on, and failed on",
    ),
    spritePrivilegesPolicy: resource(
      privileges.row,
      "One Sprite's latest outcome from an organization privileges policy set or removal; instance name privilegesPolicy-<sprite>",
    ),
    resourcesPolicyRollout: resource(
      resources.summary,
      "Which Sprites the last resources policy rollout matched, set or removed on, and failed on",
    ),
    spriteResourcesPolicy: resource(
      resources.row,
      "One Sprite's latest outcome from an organization resources policy set or removal; instance name resourcesPolicy-<sprite>",
    ),
    sprites: resource(
      InventorySchema,
      "Current Sprites and capacity limits for one organization",
    ),
  },
  methods: {
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
      network.summary,
      (args, context: Context) =>
        rolloutPolicy(
          context,
          "network",
          "set",
          NetworkPolicy,
          args.select,
          args.policy,
        ),
    ),
    setPrivilegesPolicy: method(
      "Set the privileges policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as privilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: PrivilegesPolicy }),
      "privilegesPolicyRollout",
      privileges.summary,
      (args, context: Context) =>
        rolloutPolicy(
          context,
          "privileges",
          "set",
          PrivilegesPolicy,
          args.select,
          args.policy,
        ),
    ),
    setResourcesPolicy: method(
      "Set the resources policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as resourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector, policy: ResourcesPolicy }),
      "resourcesPolicyRollout",
      resources.summary,
      (args, context: Context) =>
        rolloutPolicy(
          context,
          "resources",
          "set",
          ResourcesPolicy,
          args.select,
          args.policy,
        ),
    ),
    deletePrivilegesPolicy: method(
      "Remove the privileges policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as privilegesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "privilegesPolicyRollout",
      privileges.summary,
      (args, context: Context) =>
        rolloutPolicy(
          context,
          "privileges",
          "delete",
          PrivilegesPolicy,
          args.select,
          null,
        ),
    ),
    deleteResourcesPolicy: method(
      "Remove the resources policy from every Sprite the selector matches; a failed Sprite is recorded and the rest continue; each Sprite's outcome is also saved as resourcesPolicy-<sprite>",
      z.object({ select: SpriteSelector }),
      "resourcesPolicyRollout",
      resources.summary,
      (args, context: Context) =>
        rolloutPolicy(
          context,
          "resources",
          "delete",
          ResourcesPolicy,
          args.select,
          null,
        ),
    ),
    ...connectorsMethods,
  },
};
