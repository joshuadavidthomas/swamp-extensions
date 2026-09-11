// SPDX-License-Identifier: MIT

/**
 * Swamp model for reading a Fly.io Sprites organization inventory.
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
  InvalidResponseError,
  jsonRequest,
  method,
  resource,
  ResponseLimitError,
} from "./_lib/core.ts";

import { SpriteResponse } from "./_lib/sprite.ts";

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

/** Fly.io Sprites organization inventory model. */
export const model = {
  type: "@josh/sprites/organization",
  version: "2026.09.10.1",
  // Inventory allows 30 seconds per page, including larger organization lists.
  globalArguments: AuthSchema.extend({
    timeoutMs: AuthSchema.shape.timeoutMs.default(30_000),
  }),
  resources: {
    inventory: resource(
      InventorySchema,
      "Current Sprites and capacity limits for one organization",
    ),
  },
  methods: {
    lookup: method(
      "Read every Sprite visible to the organization token",
      LookupArgsSchema,
      "inventory",
      InventorySchema,
      async (args, context: Context) => {
        const budget = { remaining: context.globalArgs.maxResponseBytes };
        const seenTokens = new Set<string>();
        let page = await listSpritesPage(context, args, budget);
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
          page = await listSpritesPage(context, args, budget, token);
          sprites.push(...page.sprites);
        }

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
  },
};
