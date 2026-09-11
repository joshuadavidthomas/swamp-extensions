// SPDX-License-Identifier: MIT
/** The Sprite's local management API at /.sprite/api.sock, reached with curl through authenticated exec.
 * None of these routes appear in sprites.dev/api or docs.sprites.dev; they were verified live. @module */
import { z } from "zod";
import { type Context, deadline } from "./core.ts";
import { executeHttp } from "./exec.ts";

/** Native exec boundary; credentials stay on the outer TLS connection. */
export type ManagementExec = typeof executeHttp;
export type Request = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: `/v1/services/${string}` | "/v1/tasks" | `/v1/tasks/${string}`;
  body?: {
    name?: string;
    signal?: string;
    expire?: string | number;
  };
  statuses: readonly number[];
};

/** One socket request, never retried or redirected; failures never expose remote output. */
export async function send(
  ctx: Context,
  sprite: string,
  request: Request,
  execute: ManagementExec,
): Promise<string> {
  const operation = deadline(ctx);
  const bounded = { ...ctx, signal: operation.signal };
  try {
    operation.check(
      "Sprite management request exceeded timeoutMs before exec.",
    );
    const remaining = operation.remainingMs();
    const body = request.body === undefined
      ? new Uint8Array()
      : new TextEncoder().encode(JSON.stringify(request.body));
    const result = await execute(
      {
        ...bounded,
        globalArgs: { ...ctx.globalArgs, timeoutMs: remaining },
      },
      sprite,
      {
        cmd: [
          "/usr/bin/curl",
          "--disable",
          "--silent",
          "--show-error",
          "--fail-with-body",
          "--unix-socket",
          "/.sprite/api.sock",
          "--noproxy",
          "*",
          "--proto",
          "=http",
          "--header",
          "Content-Type: application/json",
          "--max-time",
          String(remaining / 1000),
          "--max-filesize",
          String(ctx.globalArgs.maxResponseBytes),
          "--request",
          request.method,
          "--write-out",
          "\n%{http_code}",
          ...(request.body === undefined ? [] : ["--data-binary", "@-"]),
          `http://sprite${request.path}`,
        ],
        stdin: request.body !== undefined,
      },
      body,
    );
    operation.check("Sprite management request exceeded timeoutMs.");
    if (result.exitCode !== 0 && result.exitCode !== 22) {
      throw new Error(
        `Sprite management exec failed with exit code ${result.exitCode}; inspect the Sprite before retrying.`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } catch {
      throw new Error("Sprite management returned invalid UTF-8.");
    }
    const match = /\n([1-5]\d{2})$/.exec(text);
    if (!match) {
      throw new Error(
        "Sprite management response ended without a valid HTTP status.",
      );
    }
    const status = Number(match[1]);
    if (!request.statuses.includes(status)) {
      throw new Error(
        `Sprite management ${request.method} returned HTTP ${status}; no output was saved.`,
      );
    }
    return text.slice(0, match.index);
  } finally {
    operation.dispose();
  }
}

export const read = async <S extends z.ZodType>(
  ctx: Context,
  sprite: string,
  path: Request["path"],
  schema: S,
  execute: ManagementExec,
): Promise<z.output<S>> => {
  const body = await send(
    ctx,
    sprite,
    { method: "GET", path, statuses: [200] },
    execute,
  );
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Sprite management returned invalid JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Sprite management response does not match its schema.");
  }
  return parsed.data;
};
