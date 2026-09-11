// SPDX-License-Identifier: MIT

/**
 * Swamp model for reading a Fly.io Sprites organization inventory.
 * The model keeps API credentials out of stored data and normalizes API values
 * into JSON-safe fields that other models can read with CEL expressions.
 *
 * @module
 */

import { z } from "zod";
import {
  AuthSchema,
  type Context,
  method,
  resource,
  responseBytes,
  ResponseLimitError,
} from "./_lib/core.ts";

import { SpriteResponse } from "./_lib/sprite-api.ts";

const LookupArgsSchema = z.object({
  prefix: z.string().min(1).optional().describe(
    "Only include Sprite names with this prefix.",
  ),
  pageSize: z.number().int().min(1).max(500).default(500).describe(
    "Sprites requested per API page.",
  ),
});

const UrlSettingsSchema = z.object({
  auth: z.enum(["sprite", "public"]),
  privateAccess: z.enum(["admins", "org_users"]).nullable(),
});

const SpriteSchema = z.object({
  id: z.string(),
  name: z.string(),
  organization: z.string(),
  status: z.enum(["cold", "warm", "running"]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  url: z.string(),
  urlSettings: UrlSettingsSchema.nullable(),
  version: z.string().nullable(),
  environmentVersion: z.string().nullable(),
  labels: z.array(z.string()),
  lastRunningAt: z.iso.datetime({ offset: true }).nullable(),
  lastWarmingAt: z.iso.datetime({ offset: true }).nullable(),
});

const ApiPageSchema = z.object({
  sprites: z.array(SpriteResponse),
  has_more: z.boolean(),
  next_continuation_token: z.string().nullish(),
  name: z.string(),
  running: z.number().int().nonnegative(),
  warm: z.number().int().nonnegative(),
  cold: z.number().int().nonnegative(),
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
  sprites: z.array(SpriteSchema),
  prefix: z.string().nullable(),
  truncated: z.boolean(),
  observedAt: z.iso.datetime({ offset: true }),
});

type ApiPage = z.infer<typeof ApiPageSchema>;
type ApiSprite = z.infer<typeof SpriteResponse>;
type Inventory = z.infer<typeof InventorySchema>;
type NormalizedSprite = z.infer<typeof SpriteSchema>;

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeSprite(sprite: ApiSprite): NormalizedSprite {
  return {
    id: sprite.id,
    name: sprite.name,
    organization: sprite.organization,
    status: sprite.status,
    createdAt: sprite.created_at,
    updatedAt: sprite.updated_at,
    url: sprite.url,
    urlSettings: sprite.url_settings
      ? {
        auth: sprite.url_settings.auth,
        privateAccess: sprite.url_settings.private_access ?? null,
      }
      : null,
    version: sprite.version ?? null,
    environmentVersion: sprite.environment_version ?? null,
    labels: sprite.labels ?? [],
    lastRunningAt: sprite.last_running_at ?? null,
    lastWarmingAt: sprite.last_warming_at ?? null,
  };
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
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
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  if (milliseconds === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function listSpritesPage(
  globalArgs: Context["globalArgs"],
  signal: AbortSignal,
  args: z.infer<typeof LookupArgsSchema>,
  budget: { remaining: number },
  continuationToken?: string,
): Promise<ApiPage> {
  const url = new URL("/v1/sprites", withoutTrailingSlash(globalArgs.baseUrl));
  url.searchParams.set("max_results", String(args.pageSize));
  if (args.prefix) {
    url.searchParams.set("prefix", args.prefix);
  }
  if (continuationToken) {
    url.searchParams.set("continuation_token", continuationToken);
  }

  const retryableStatuses = new Set([429, 502, 503, 504]);
  const maxAttempts = 3;
  let response: Response | undefined;
  let body = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${globalArgs.token}`,
        },
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(globalArgs.timeoutMs),
        ]),
      });
      const bytes = await responseBytes(response, budget.remaining);
      budget.remaining -= bytes.length;
      body = new TextDecoder().decode(bytes);
    } catch (error) {
      if (
        signal.aborted || error instanceof ResponseLimitError ||
        attempt === maxAttempts
      ) {
        throw new Error(`Sprites API request failed: ${messageFrom(error)}`, {
          cause: error,
        });
      }
      await waitForRetry(250 * 2 ** (attempt - 1), signal);
      continue;
    }

    if (response.ok || !retryableStatuses.has(response.status)) {
      break;
    }
    if (attempt < maxAttempts) {
      const delay = retryDelayMs(response, attempt);
      if (delay > globalArgs.timeoutMs) {
        throw new Error(
          `Sprites API returned HTTP ${response.status} with a retry delay of ${delay}ms, longer than timeoutMs`,
        );
      }
      await waitForRetry(delay, signal);
    }
  }

  if (!response) {
    throw new Error("Sprites API request ended without a response");
  }
  if (!response.ok) {
    throw new Error(`Sprites API returned HTTP ${response.status}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new Error("Sprites API returned invalid JSON.");
  }

  const parsed = ApiPageSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `Sprites API returned an unexpected list response: ${
        z.prettifyError(parsed.error)
      }`,
    );
  }
  return parsed.data;
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
        context.logger.info("Reading Sprites organization inventory", {
          prefix: args.prefix ?? "all",
        });

        const sprites: ApiSprite[] = [];
        const budget = { remaining: context.globalArgs.maxResponseBytes };
        const seenContinuationTokens = new Set<string>();
        let continuationToken: string | undefined;
        let organizationName: string | undefined;
        let runningLimit: number | undefined;
        let warmLimit: number | undefined;

        try {
          do {
            const page = await listSpritesPage(
              context.globalArgs,
              context.signal,
              args,
              budget,
              continuationToken,
            );

            sprites.push(...page.sprites);
            organizationName ??= page.name;
            runningLimit ??= page.running_limit ?? undefined;
            warmLimit ??= page.warm_limit ?? undefined;

            if (!page.has_more) {
              continuationToken = undefined;
              break;
            }

            const nextToken = page.next_continuation_token ?? undefined;
            if (!nextToken) {
              throw new Error(
                "Sprites API reported another page without a continuation token",
              );
            }
            if (seenContinuationTokens.has(nextToken)) {
              throw new Error(
                "Sprites API repeated a continuation token while listing Sprites",
              );
            }

            seenContinuationTokens.add(nextToken);
            continuationToken = nextToken;
          } while (continuationToken);
        } catch (error) {
          throw new Error(
            `Could not read Sprites organization inventory: ${
              messageFrom(error)
            }`,
            { cause: error },
          );
        }

        organizationName ??= sprites[0]?.organization;
        if (!organizationName) {
          throw new Error(
            "Sprites API response did not identify the token's organization",
          );
        }

        const normalizedSprites = sprites.map(normalizeSprite);
        const statusCounts = { running: 0, warm: 0, cold: 0 };
        for (const sprite of normalizedSprites) {
          statusCounts[sprite.status] += 1;
        }

        const inventory: Inventory = {
          organization: {
            name: organizationName,
            runningLimit: runningLimit ?? null,
            warmLimit: warmLimit ?? null,
          },
          counts: {
            total: normalizedSprites.length,
            ...statusCounts,
          },
          sprites: normalizedSprites,
          prefix: args.prefix ?? null,
          truncated: false,
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
