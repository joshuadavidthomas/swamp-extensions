// SPDX-License-Identifier: MIT
/** Shared selection, listing, and sequential organization operations. @module */
import { z } from "zod";
import {
  ApiError,
  type Context,
  type Handle,
  InvalidResponseError,
  jsonRequest,
  ResponseLimitError,
  withHandles,
} from "./core.ts";
import { SpriteResponse } from "./sprite.ts";

export type Sprite = z.output<typeof SpriteResponse>;
type WithHandles<T> = ReturnType<typeof withHandles<T>>;

export const LookupArgsSchema = z.object({
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

/** Which Sprites an organization-wide operation touches. Matching happens at call time; nothing is bound. */
export const SpriteSelector = z.object({
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
export const SelectorEcho = z.object({
  all: z.literal(true).optional(),
  prefix: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

/** One Sprite's outcome. Extra fields come from the operation. */
export const Outcome = z.object({
  name: z.string(),
  id: z.string(),
  status: z.enum(["applied", "failed"]),
  error: z.string().optional(),
});

/** Summary of one run over a selector. */
export function summarySchema<E extends z.ZodObject>(extra: E) {
  return z.object({
    select: SelectorEcho,
    matched: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    results: z.array(Outcome.extend(extra.shape)),
    observedAt: z.iso.datetime({ offset: true }),
  });
}

/** One Sprite's record, with operation fields and the run timestamp.
 * Extra fields must accept omission on failures: use optional fields (nullable alone does not accept absence).
 */
export function recordSchema<E extends z.ZodObject>(extra: E) {
  return Outcome.extend(extra.shape).extend({
    observedAt: z.iso.datetime({ offset: true }),
  });
}

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
export async function listAllSprites(
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

/** Run sequentially in listing order, saving each outcome immediately. Parent cancellation rethrows. */
export async function fanOut<E extends z.ZodObject>(
  context: Context,
  select: z.output<typeof SpriteSelector>,
  spec: string,
  recordPrefix: string,
  extra: E,
  operate: (
    sprite: Sprite,
  ) => Promise<z.input<E> & { failed?: string; handles?: Handle[] }>,
): Promise<WithHandles<z.input<ReturnType<typeof summarySchema<E>>>>> {
  const rowSchema = recordSchema(extra);
  const resultSchema = Outcome.extend(extra.shape);
  const budget = { remaining: context.globalArgs.maxResponseBytes };
  const { sprites } = await listAllSprites(
    context,
    { prefix: select.prefix },
    budget,
  );
  const wanted = select.labels ?? [];
  const matched = sprites.filter((sprite) =>
    wanted.every((label) => sprite.labels?.includes(label))
  );
  const results: z.input<typeof resultSchema>[] = [];
  const handles = [];
  const observedAt = new Date().toISOString();
  for (const sprite of matched) {
    let row;
    try {
      const { failed, handles: operationHandles = [], ...extraFields } =
        await operate(sprite);
      handles.push(...operationHandles);
      row = {
        name: sprite.name,
        id: sprite.id,
        ...extraFields,
        status: typeof failed === "string" ? "failed" : "applied",
        ...(typeof failed === "string" ? { error: failed } : {}),
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
    results.push(resultSchema.parse(row));
    handles.push(
      await context.writeResource(
        spec,
        `${recordPrefix}-${sprite.name}`,
        rowSchema.parse({ ...row, observedAt }),
      ),
    );
  }
  const applied =
    results.filter((result) => result.status === "applied").length;
  context.logger.info("{recordPrefix}: {applied} of {matched} Sprites", {
    recordPrefix,
    applied,
    matched: matched.length,
  });
  return withHandles({
    select,
    matched: matched.length,
    applied,
    failed: matched.length - applied,
    results,
    observedAt,
  }, handles);
}
