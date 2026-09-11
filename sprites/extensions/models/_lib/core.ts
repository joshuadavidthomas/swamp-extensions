// SPDX-License-Identifier: MIT
/** Shared HTTP, output, and method boundaries for the Sprites API. @module */
import { z } from "zod";

/** Binary input accepts text or base64; it never reads paths on the Swamp host. */
export const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("base64"), base64: z.base64() }),
]);
/** Resolve input bytes without text conversion of binary artifacts. */
export function inputBytes(
  input: z.output<typeof Input> | undefined,
): Promise<Uint8Array> {
  return Promise.resolve(
    !input
      ? new Uint8Array()
      : input.kind === "text"
      ? new TextEncoder().encode(input.text)
      : Uint8Array.fromBase64(input.base64),
  );
}

/** Credentials and transport limits shared by organization-scoped models. */
export const AuthSchema = z.object({
  token: z.string().min(1).regex(
    /^[\x21-\x7e]+$/,
    "Use a bearer token without spaces or control characters.",
  ).meta({ sensitive: true }).describe(
    "Organization token; use a vault reference.",
  ),
  baseUrl: z.url().refine(
    (value) => new URL(value).protocol === "https:",
    "Use an HTTPS API endpoint.",
  ).default("https://api.sprites.dev"),
  timeoutMs: z.number().int().min(1).max(2_147_483_647).default(300_000),
  maxResponseBytes: z.number().int().min(1).max(1_073_741_824).default(
    67_108_864,
  ),
});
/** Organization authentication and request limits. */
export type Auth = z.output<typeof AuthSchema>;
/** Minimal resource handle supplied by Swamp. */
export type Handle = { name: string };
/** Swamp method boundary; only fields used by this extension are declared. */
export type Context<G extends Auth = Auth> = {
  globalArgs: G;
  signal: AbortSignal;
  logger: { info(message: string, ...args: unknown[]): void };
  writeResource(
    spec: string,
    name: string,
    data: object,
  ): Promise<Handle>;
  readResource(name: string): Promise<unknown>;
  deleteResource(name: string): Promise<void>;
  createFileWriter(
    spec: string,
    name: string,
  ): { writeAll(data: Uint8Array): Promise<Handle> };
};
/** Method result returned to Swamp. */
export type Result = { dataHandles: Handle[] };
/** Query values retain repeated parameters such as exec cmd and env. */
export type Query = Record<
  string,
  string | number | boolean | string[] | undefined
>;
/** HTTP errors retain the request location and status without response payloads. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`Sprites ${method} ${path} returned HTTP ${status}`);
  }
}
/** Encode one path segment, rejecting dot segments that URL resolution would collapse. */
export function segment(value: string): string {
  if (!value || value === "." || value === "..") {
    throw new Error(
      "A resource identifier must not be empty or a dot segment.",
    );
  }
  return encodeURIComponent(value);
}
/** Construct an API URL with explicitly encoded query parameters. */
export function apiUrl(auth: Auth, path: string, query: Query = {}): URL {
  const url = new URL(path, auth.baseUrl);
  if (url.origin !== new URL(auth.baseUrl).origin) {
    throw new Error("API paths must stay on the configured origin.");
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(item));
    }
  }
  return url;
}
/** Fetch exactly once. Mutations are never automatically replayed. */
export async function request(
  ctx: Pick<Context, "globalArgs" | "signal">,
  method: string,
  path: string,
  options: {
    query?: Query;
    json?: unknown;
    bytes?: Uint8Array;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${ctx.globalArgs.token}`);
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(ctx.globalArgs, path, options.query), {
      method,
      headers,
      redirect: "error",
      body: options.json !== undefined
        ? JSON.stringify(options.json)
        : options.bytes === undefined
        ? undefined
        : new Uint8Array(options.bytes),
      signal: AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(ctx.globalArgs.timeoutMs),
      ]),
    });
  } catch {
    ctx.signal.throwIfAborted();
    throw new Error(
      `Sprites ${method} ${path} failed before receiving a response; the server may have accepted the operation. Inspect its state before retrying.`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ApiError(response.status, method, path);
  }
  return response;
}

/** A response size violation is permanent and must not be retried. */
export class ResponseLimitError extends Error {}
/** Consume a response with a byte limit; exceeding the limit fails rather than truncating data. */
export async function responseBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) {
        throw new ResponseLimitError(
          `Sprites response exceeds maxResponseBytes (${limit}); no complete output was saved.`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return concatenate(chunks);
}
/** Read and validate a JSON response without including payloads in validation errors. */
export async function jsonRequest<S extends z.ZodType>(
  ctx: Pick<Context, "globalArgs" | "signal">,
  method: string,
  path: string,
  schema: S,
  options: Parameters<typeof request>[3] = {},
): Promise<z.output<S>> {
  const response = await request(ctx, method, path, options);
  const bytes = await responseBytes(response, ctx.globalArgs.maxResponseBytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error(
      `Sprites ${method} ${path} returned an invalid JSON response.`,
    );
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((issue) => {
      const field = issue.path.map(String).join(".")
        .replaceAll(ctx.globalArgs.token, "[redacted]")
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, 200);
      return `${field || "response"}: ${issue.code}`;
    }).join("; ");
    const rootType = decoded === null
      ? "null"
      : Array.isArray(decoded)
      ? "array"
      : typeof decoded;
    throw new Error(
      `Sprites ${method} ${path} returned an invalid JSON response for its schema (root ${rootType}; ${issues}).`,
    );
  }
  return parsed.data;
}
/** Consume a successful operation whose response body has no public contract. */
export async function emptyRequest(
  ctx: Pick<Context, "globalArgs" | "signal">,
  method: string,
  path: string,
  options: Parameters<typeof request>[3] = {},
): Promise<void> {
  const response = await request(ctx, method, path, options);
  await response.body?.cancel();
}
/** Typed specification for persisted JSON data. */
export function resource<S extends z.ZodType>(
  schema: S,
  description: string,
  lifetime = "infinite",
) {
  return { schema, description, lifetime, garbageCollection: 10 };
}
/** Binary artifact specification. Artifacts may contain user data and secrets. */
export const BinaryFile = {
  description: "Operation bytes; may contain application secrets",
  contentType: "application/octet-stream",
  lifetime: "7d",
  garbageCollection: 10,
};
const extraHandles = Symbol("extraHandles");

type WithHandles<T> = {
  [extraHandles]: true;
  data: T;
  handles: Handle[];
};

export function withHandles<T>(data: T, handles: Handle[]): WithHandles<T> {
  return { [extraHandles]: true, data, handles };
}

/** Wrap a validated operation with logging, optional resource output, and artifact handles. */
export function method<
  A extends z.ZodType,
  O extends z.ZodObject,
  G extends Auth = Auth,
>(
  description: string,
  args: A,
  spec: string,
  output: O,
  run: (
    args: z.output<A>,
    ctx: Context<G>,
  ) => Promise<z.input<O> | WithHandles<z.input<O>>>,
): {
  description: string;
  arguments: A;
  execute(input: z.output<A>, ctx: Context<G>): Promise<Result>;
};
export function method<A extends z.ZodType, G extends Auth = Auth>(
  description: string,
  args: A,
  spec: string,
  output: null,
  run: (
    args: z.output<A>,
    ctx: Context<G>,
  ) => Promise<void | WithHandles<void>>,
): {
  description: string;
  arguments: A;
  execute(input: z.output<A>, ctx: Context<G>): Promise<Result>;
};
export function method<
  A extends z.ZodType,
  O extends z.ZodObject,
  G extends Auth = Auth,
>(
  description: string,
  args: A,
  spec: string,
  output: O | null,
  run: (
    args: z.output<A>,
    ctx: Context<G>,
  ) => Promise<z.input<O> | void | WithHandles<z.input<O> | void>>,
) {
  return {
    description,
    arguments: args,
    execute: async (input: z.output<A>, ctx: Context<G>): Promise<Result> => {
      ctx.logger.info("Starting {operation}", { operation: description });
      const result = await run(input, ctx);
      const wrapped = typeof result === "object" && result !== null &&
        extraHandles in result;
      const data = wrapped ? result.data : result;
      const dataHandles = wrapped ? [...result.handles] : [];
      ctx.signal.throwIfAborted();
      if (output !== null) {
        const resourceHandle = await ctx.writeResource(
          spec,
          spec,
          output.parse(data),
        );
        dataHandles.push(resourceHandle);
      }
      ctx.logger.info("Finished {operation}", { operation: description });
      return { dataHandles };
    },
  };
}

/** One deadline for an operation: the method signal joined with timeoutMs. */
export function deadline(ctx: Pick<Context, "signal" | "globalArgs">): {
  signal: AbortSignal;
  check(message: string): void;
  remainingMs(): number;
  dispose(): void;
} {
  const expiresAt = performance.now() + ctx.globalArgs.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.globalArgs.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, controller.signal]);
  const remainingMs = (): number => Math.max(0, expiresAt - performance.now());
  return {
    signal,
    check(message) {
      if (signal.aborted || remainingMs() === 0) throw new Error(message);
    },
    remainingMs,
    dispose() {
      clearTimeout(timer);
    },
  };
}
/** Decode complete NDJSON streams, including errors carried in a successful HTTP response. */
export async function ndjson<S extends z.ZodType>(
  ctx: Pick<Context, "globalArgs" | "signal">,
  method: string,
  path: string,
  schema: S,
  options: Parameters<typeof request>[3] = {},
): Promise<z.output<S>[]> {
  const response = await request(ctx, method, path, options);
  const bytes = await responseBytes(response, ctx.globalArgs.maxResponseBytes);
  const events: z.output<S>[] = [];
  for (
    const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(
      "\n",
    )
  ) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Sprites ${path} returned malformed NDJSON.`);
    }
    if (
      typeof value === "object" && value !== null &&
      ("error" in value && value.error ||
        "type" in value && value.type === "error")
    ) {
      throw new Error(
        `Sprites ${path} reported an error in its progress stream.`,
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Sprites ${path} returned an invalid progress event.`);
    }
    events.push(parsed.data);
  }
  return events;
}

/** Assemble binary chunks without text conversion. */
export function concatenate(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
