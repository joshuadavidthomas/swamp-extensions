// SPDX-License-Identifier: MIT
/** Typed local management operations reached through authenticated HTTP exec. @module */
import { z } from "zod";
import {
  Acknowledgement,
  method as coreMethod,
  resource,
  segment,
} from "./core.ts";
import { executeHttp } from "./exec-http.ts";
import { type SpriteContext, verifySprite } from "./sprite-api.ts";
import { Service } from "./sprite-rest.ts";

/** Native exec boundary; credentials stay on the outer TLS connection. */
export type ManagementExec = typeof executeHttp;
const Name = z.string().min(1).max(256).refine(
  (name) => name !== "." && name !== "..",
  "A management resource name must not be a dot segment.",
);
const units: Record<string, number> = {
  ns: 1e-9,
  us: 1e-6,
  "µs": 1e-6,
  ms: 1e-3,
  s: 1,
  m: 60,
  h: 3600,
};
/** Tasks accept seconds or Go-style durations, bounded to the provider's one-hour limit. */
export const TaskExpiry = z.union([
  z.number().int().positive().max(3600),
  z.string().min(1).max(128).refine((text) => {
    const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)];
    const seconds = parts.reduce(
      (sum, part) => sum + Number(part[1]) * units[part[2]],
      0,
    );
    return parts.map((part) => part[0]).join("") === text && seconds > 0 &&
      seconds <= 3600;
  }, "Task expiration must be a positive duration of at most one hour."),
]);
const Task = z.object({
  name: Name,
  started_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
});
const TaskList = z.object({ tasks: z.array(Task) });
const Tasks = TaskList.extend({ truncated: z.literal(false) });
const TaskArgs = z.object({ name: Name, expire: TaskExpiry });
const TaskAccepted = TaskArgs.extend({ accepted: z.literal(true) });

type Request = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: `/v1/services/${string}` | "/v1/tasks" | `/v1/tasks/${string}`;
  body?: {
    name?: string;
    signal?: string;
    expire?: z.output<typeof TaskExpiry>;
  };
  statuses: readonly number[];
};

/** One socket request, never retried or redirected; failures never expose remote output. */
async function managementRequest(
  ctx: SpriteContext,
  request: Request,
  execute: ManagementExec = executeHttp,
): Promise<string> {
  const deadline = performance.now() + ctx.globalArgs.timeoutMs;
  const bounded = {
    ...ctx,
    signal: AbortSignal.any([
      ctx.signal,
      AbortSignal.timeout(ctx.globalArgs.timeoutMs),
    ]),
  };
  // Even local reads start a process. Require the saved identity for every exec.
  await verifySprite(bounded);
  bounded.signal.throwIfAborted();
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) {
    throw new Error(
      "Sprite management request exceeded timeoutMs before exec.",
    );
  }
  const body = request.body === undefined
    ? new Uint8Array()
    : new TextEncoder().encode(JSON.stringify(request.body));
  const result = await execute({
    ...bounded,
    globalArgs: { ...ctx.globalArgs, timeoutMs: remaining },
  }, {
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
  }, body);
  bounded.signal.throwIfAborted();
  if (performance.now() >= deadline) {
    throw new Error("Sprite management request exceeded timeoutMs.");
  }
  if (
    result.stdout.length + result.stderr.length >
      ctx.globalArgs.maxResponseBytes
  ) {
    throw new Error("Sprite management response exceeded maxResponseBytes.");
  }
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
  if ((result.exitCode === 22) !== (status >= 400)) {
    throw new Error(
      "Sprite management HTTP status and curl exit code disagree.",
    );
  }
  if (!request.statuses.includes(status)) {
    throw new Error(
      `Sprite management ${request.method} returned HTTP ${status}; no output was saved.`,
    );
  }
  return text.slice(0, match.index);
}

/** Build typed operations with a replaceable native exec boundary for contract tests. */
export function createManagementMethods(execute: ManagementExec = executeHttp) {
  function method<A extends z.ZodType, O extends z.ZodObject>(
    description: string,
    args: A,
    spec: string,
    output: O,
    run: (args: z.output<A>, ctx: SpriteContext) => Promise<z.input<O>>,
  ) {
    const operation = coreMethod(description, args, spec, output, run);
    return {
      ...operation,
      execute: async (input: z.output<A>, ctx: SpriteContext) => {
        const deadline = performance.now() + ctx.globalArgs.timeoutMs;
        const signal = AbortSignal.any([
          ctx.signal,
          AbortSignal.timeout(ctx.globalArgs.timeoutMs),
        ]);
        return await operation.execute(input, {
          ...ctx,
          signal,
          writeResource: (spec, name, data) => {
            signal.throwIfAborted();
            if (performance.now() >= deadline) {
              throw new Error(
                "Sprite management validation exceeded timeoutMs; no output was saved.",
              );
            }
            return ctx.writeResource(spec, name, data);
          },
        });
      },
    };
  }
  const send = (ctx: SpriteContext, request: Request) =>
    managementRequest(ctx, request, execute);
  const read = async <S extends z.ZodType>(
    ctx: SpriteContext,
    path: Request["path"],
    schema: S,
  ): Promise<z.output<S>> => {
    const body = await send(ctx, { method: "GET", path, statuses: [200] });
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
  return {
    getService: method(
      "Read a configured Sprite service through the Sprite management socket",
      z.object({ service_name: Name }),
      "service",
      Service,
      async (args, ctx: SpriteContext) => {
        const service = await read(
          ctx,
          `/v1/services/${segment(args.service_name)}`,
          Service,
        );
        if (service.name !== args.service_name) {
          throw new Error(
            "Sprite management returned a different service than requested.",
          );
        }
        return service;
      },
    ),
    signalService: method(
      "Signal a service through the Sprite management socket",
      z.object({ service_name: Name, signal: z.string().min(1).max(32) }),
      "serviceSignaled",
      Acknowledgement,
      async (args, ctx: SpriteContext) => {
        await send(ctx, {
          method: "POST",
          path: "/v1/services/signal",
          body: { name: args.service_name, signal: args.signal },
          statuses: [204],
        });
        return { completed: true as const };
      },
    ),
    listTasks: method(
      "List active task holds through the Sprite management socket",
      z.object({}),
      "tasks",
      Tasks,
      async (_args, ctx: SpriteContext) => ({
        ...await read(ctx, "/v1/tasks", TaskList),
        truncated: false as const,
      }),
    ),
    getTask: method(
      "Read an active task hold",
      z.object({ name: Name }),
      "task",
      Task,
      async (args, ctx: SpriteContext) =>
        await read(ctx, `/v1/tasks/${segment(args.name)}`, Task),
    ),
    createTask: method(
      "Create a task hold; an existing name fails rather than being refreshed",
      TaskArgs,
      "taskCreated",
      TaskAccepted,
      async (args, ctx: SpriteContext) => {
        await send(ctx, {
          method: "POST",
          path: "/v1/tasks",
          body: args,
          statuses: [201],
        });
        return { ...args, accepted: true as const };
      },
    ),
    refreshTask: method(
      "Refresh a named task hold, or create it if absent",
      TaskArgs,
      "taskRefreshed",
      TaskAccepted,
      async (args, ctx: SpriteContext) => {
        await send(ctx, {
          method: "PUT",
          path: `/v1/tasks/${segment(args.name)}`,
          body: { expire: args.expire },
          statuses: [200],
        });
        return { ...args, accepted: true as const };
      },
    ),
    putTask: method(
      "Create or refresh a task hold through the collection PUT endpoint",
      TaskArgs,
      "taskPut",
      TaskAccepted,
      async (args, ctx: SpriteContext) => {
        await send(ctx, {
          method: "PUT",
          path: "/v1/tasks",
          body: args,
          statuses: [200],
        });
        return { ...args, accepted: true as const };
      },
    ),
    deleteTask: method(
      "Release a task hold; an already absent task succeeds",
      z.object({ name: Name }),
      "taskDeleted",
      Acknowledgement,
      async (args, ctx: SpriteContext) => {
        await send(ctx, {
          method: "DELETE",
          path: `/v1/tasks/${segment(args.name)}`,
          statuses: [204, 404],
        });
        return { completed: true as const };
      },
    ),
  };
}
/** Management methods are ordinary typed Sprite methods, not a generic command interface. */
export const managementMethods = createManagementMethods();
/** Local API observations expire; stored task snapshots do not imply a continuing hold. */
export const managementResources = {
  serviceSignaled: resource(
    Acknowledgement,
    "Signal accepted by the local service manager",
    "7d",
  ),
  tasks: resource(
    Tasks,
    "Observed task holds; this snapshot does not keep a Sprite awake",
    "7d",
  ),
  task: resource(
    Task,
    "Observed task expiry; refresh explicitly when needed",
    "7d",
  ),
  taskCreated: resource(
    TaskAccepted,
    "Accepted task creation, not a continually renewed hold",
    "7d",
  ),
  taskRefreshed: resource(TaskAccepted, "Accepted named task upsert", "7d"),
  taskPut: resource(TaskAccepted, "Accepted collection task upsert", "7d"),
  taskDeleted: resource(
    Acknowledgement,
    "Task hold released or already absent",
    "7d",
  ),
};
