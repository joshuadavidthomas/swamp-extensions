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
} from "./_lib/core.ts";

import { connectorsMethods, connectorsResources } from "./_lib/connectors.ts";

import { NetworkPolicy } from "./_lib/policy.ts";

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
const NetworkPolicyRollout = z.object({
  select: z.object({
    all: z.literal(true).optional(),
    prefix: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  policy: NetworkPolicy,
  matched: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(RolloutResult),
  observedAt: z.iso.datetime({ offset: true }),
});

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
      NetworkPolicyRollout,
      "Which Sprites the last network policy rollout matched, applied to, and failed on",
    ),
    sprites: resource(
      InventorySchema,
      "Current Sprites and capacity limits for one organization",
    ),
  },
  methods: {
    ...connectorsMethods,
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
      "Replace the network policy on every Sprite the selector matches; a failed Sprite is recorded and the rest continue",
      z.object({ select: SpriteSelector, policy: NetworkPolicy }),
      "networkPolicyRollout",
      NetworkPolicyRollout,
      async (args, context: Context) => {
        const budget = { remaining: context.globalArgs.maxResponseBytes };
        const { sprites } = await listAllSprites(context, {
          prefix: args.select.prefix,
        }, budget);
        const wanted = args.select.labels ?? [];
        const matched = sprites.filter((sprite) =>
          wanted.every((label) => sprite.labels?.includes(label))
        );
        const results: z.input<typeof RolloutResult>[] = [];
        for (const sprite of matched) {
          try {
            await emptyRequest(
              context,
              "POST",
              spritePath(sprite.name, "/policy/network"),
              { json: args.policy },
            );
            results.push({
              name: sprite.name,
              id: sprite.id,
              status: "applied",
            });
          } catch (error) {
            if (context.signal.aborted) throw error;
            results.push({
              name: sprite.name,
              id: sprite.id,
              status: "failed",
              error: error instanceof ApiError
                ? `HTTP ${error.status}`
                : "request failed",
            });
          }
        }
        const applied =
          results.filter((result) => result.status === "applied").length;
        context.logger.info(
          "Applied network policy to {applied} of {matched} Sprites",
          { applied, matched: matched.length },
        );
        return {
          select: args.select,
          policy: args.policy,
          matched: matched.length,
          applied,
          failed: matched.length - applied,
          results,
          observedAt: new Date().toISOString(),
        };
      },
    ),
  },
};
