// SPDX-License-Identifier: MIT

/**
 * Swamp model for reading a Fly.io Sprites organization inventory.
 * The model keeps API credentials out of stored data and normalizes API values
 * into JSON-safe fields that other models can read with CEL expressions.
 *
 * @module
 */

import { z } from "zod";
import { responseBytes, ResponseLimitError } from "./_lib/core.ts";

const GlobalArgsSchema = z.object({
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "Organization-scoped Sprites API token. Use a vault reference.",
  ),
  baseUrl: z.url().refine(
    (value) => new URL(value).protocol === "https:",
    "Use an HTTPS API endpoint.",
  ).default("https://api.sprites.dev").describe(
    "Sprites API base URL without the /v1 suffix.",
  ),
  maxResponseBytes: z.number().int().min(1).max(1_073_741_824).default(
    67_108_864,
  ).describe(
    "Maximum combined response bytes across inventory pages; exceeding the limit fails without saving partial inventory.",
  ),
  timeoutMs: z.number().int().positive().max(2_147_483_647).default(30_000)
    .describe(
      "API request timeout in milliseconds.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  url: z.string(),
  urlSettings: UrlSettingsSchema.nullable(),
  version: z.string().nullable(),
  environmentVersion: z.string().nullable(),
  labels: z.array(z.string()),
  lastRunningAt: z.iso.datetime().nullable(),
  lastWarmingAt: z.iso.datetime().nullable(),
});

const ApiSpriteSchema = z.object({
  id: z.string(),
  name: z.string(),
  organization: z.string(),
  status: z.enum(["cold", "warm", "running"]),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  url: z.string(),
  url_settings: z.object({
    auth: z.enum(["sprite", "public"]),
    private_access: z.enum(["admins", "org_users"]).optional(),
  }).nullish(),
  version: z.string().nullish(),
  environment_version: z.string().nullish(),
  labels: z.array(z.string()).optional(),
  last_running_at: z.iso.datetime({ offset: true }).nullish(),
  last_warming_at: z.iso.datetime({ offset: true }).nullish(),
});

const ApiPageSchema = z.object({
  sprites: z.array(ApiSpriteSchema),
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
  observedAt: z.iso.datetime(),
});

type ApiPage = z.infer<typeof ApiPageSchema>;
type ApiSprite = z.infer<typeof ApiSpriteSchema>;
type Inventory = z.infer<typeof InventorySchema>;
type NormalizedSprite = z.infer<typeof SpriteSchema>;

type MethodContext = {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
};

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isoDate(value: string, field: string, spriteName: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Sprites API returned an invalid ${field} date for Sprite ${spriteName}`,
    );
  }
  return date.toISOString();
}

function optionalIsoDate(
  value: string | null | undefined,
  field: string,
  spriteName: string,
): string | null {
  return value ? isoDate(value, field, spriteName) : null;
}

function normalizeSprite(sprite: ApiSprite): NormalizedSprite {
  return {
    id: sprite.id,
    name: sprite.name,
    organization: sprite.organization,
    status: sprite.status,
    createdAt: isoDate(sprite.created_at, "created_at", sprite.name),
    updatedAt: isoDate(sprite.updated_at, "updated_at", sprite.name),
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
    lastRunningAt: optionalIsoDate(
      sprite.last_running_at,
      "last_running_at",
      sprite.name,
    ),
    lastWarmingAt: optionalIsoDate(
      sprite.last_warming_at,
      "last_warming_at",
      sprite.name,
    ),
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
  globalArgs: GlobalArgs,
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
  version: "2026.09.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    inventory: {
      description: "Current Sprites and capacity limits for one organization",
      schema: InventorySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    lookup: {
      description: "Read every Sprite visible to the organization token",
      arguments: LookupArgsSchema,
      execute: async (
        args: z.infer<typeof LookupArgsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
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

        const inventory: Inventory = InventorySchema.parse({
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
        });

        const handle = await context.writeResource(
          "inventory",
          "current",
          inventory,
        );

        context.logger.info("Read {count} Sprites for organization {name}", {
          count: inventory.counts.total,
          name: inventory.organization.name,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
