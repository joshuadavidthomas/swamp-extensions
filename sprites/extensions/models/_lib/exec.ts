// SPDX-License-Identifier: MIT
/** Command execution, session discovery, attachment, and termination. @module */
import { z } from "zod";
import {
  BinaryFile,
  concatenate,
  decodeFrame,
  Input,
  inputBytes,
  jsonRequest,
  method,
  ndjson,
  resource,
  segment,
  withHandles,
} from "./core.ts";
import {
  type CommandResult,
  decodeStreamFrame,
  envPairs,
  EOF_FRAME,
  executeHttp,
  stdinFrame,
} from "./exec-http.ts";
import { type ConnectChannel, openChannel } from "./socket.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite-api.ts";
import { initializeTerminal, TerminalDimension } from "./terminal.ts";

const CommandArgs = z.object({
  cmd: z.array(z.string()).min(1).describe(
    "Program and argv, encoded as repeated cmd parameters.",
  ),
  path: z.string().optional(),
  dir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional().meta({ sensitive: true }),
  input: Input.optional().meta({ sensitive: true }),
  failOnNonZero: z.boolean().default(true),
});
const TimerMs = z.number().int().nonnegative().max(2_147_483_647);
const Action = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdin"),
    atMs: TimerMs,
    input: Input,
  }),
  z.object({ type: z.literal("eof"), atMs: TimerMs }),
  z.object({
    type: z.literal("resize"),
    atMs: TimerMs,
    rows: TerminalDimension,
    cols: TerminalDimension,
  }),
  z.object({
    type: z.literal("signal"),
    atMs: TimerMs,
    signal: z.string().min(1),
  }),
]);
const SocketArgs = z.object({
  tty: z.boolean().default(false),
  rows: TerminalDimension.optional(),
  cols: TerminalDimension.optional(),
  detachable: z.boolean().default(false),
  cc: z.boolean().default(false),
  max_run_after_disconnect: z.string().optional(),
  closeStdin: z.boolean().default(true),
  actions: z.array(Action).default([]).meta({ sensitive: true }),
  detachAfterMs: TimerMs.positive().optional().describe(
    "Save session identity and disconnect after this duration instead of waiting for exit.",
  ),
}).refine(
  (args) => args.tty || (args.rows === undefined && args.cols === undefined),
  "Exec rows and cols require a TTY session.",
);
/** WebSocket command arguments. */
export const ExecArgs = SocketArgs.safeExtend(CommandArgs.shape);
/** Attachment uses the server session_info to determine TTY mode. */
export const AttachArgs = SocketArgs.safeExtend({
  session_id: z.string().min(1),
  input: Input.optional().meta({ sensitive: true }),
  failOnNonZero: z.boolean().default(true),
});
/** Text control frames emitted by the exec protocol. */
export const ExecControl = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exit"), exit_code: z.number().int() }),
  z.object({
    type: z.enum([
      "session_info",
      "port_opened",
      "port_closed",
      "debug",
      "error",
    ]),
    session_id: z.string().optional(),
    command: z.string().optional(),
    created: z.number().optional(),
    is_owner: z.boolean().optional(),
    tty: z.boolean().optional(),
    cols: z.number().optional(),
    rows: z.number().optional(),
    port: z.number().optional(),
    address: z.string().optional(),
    pid: z.number().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
]);
const Execution = z.object({
  status: z.enum(["exited", "detached"]),
  exitCode: z.number().int().nullable(),
  sessionId: z.string().nullable(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  controls: z.array(ExecControl).meta({ sensitive: true }),
});
const Session = z.object({
  id: z.union([z.string(), z.number().int()]),
  command: z.string().meta({ sensitive: true }),
  workdir: z.string(),
  created: z.string(),
  bytes_per_second: z.number(),
  is_active: z.boolean(),
  tty: z.boolean(),
  last_activity: z.string().optional(),
});
const Sessions = z.object({ sessions: z.array(Session) });
const KillEvent = z.object({
  type: z.enum(["signal", "timeout", "exited", "killed", "error", "complete"]),
  message: z.string().optional(),
  signal: z.string().optional(),
  pid: z.number().int().optional(),
  exit_code: z.number().int().optional(),
});
const Killed = z.object({ events: z.array(KillEvent) });
/** Socket outcome includes bytes plus explicit exit or detach state. */
export type SocketResult = Omit<CommandResult, "exitCode"> & {
  exitCode: number | null;
  sessionId: string | null;
  controls: z.output<typeof ExecControl>[];
  status: "exited" | "detached";
};

/** Run the exec protocol, preserving text control frames and binary stream frames. */
export async function executeSocket(
  ctx: SpriteContext,
  args: z.output<typeof ExecArgs> | z.output<typeof AttachArgs>,
  connect: ConnectChannel = openChannel,
): Promise<SocketResult> {
  const attaching = "session_id" in args;
  const command = attaching ? {} : args.tty
    ? initializeTerminal(
      { cmd: args.cmd, path: args.path },
      args.rows,
      args.cols,
    )
    : { cmd: args.cmd, path: args.path };
  const query = {
    ...(!attaching
      ? {
        ...command,
        env: envPairs(args.env),
        dir: args.dir,
      }
      : {}),
    stdin: true,
    tty: args.tty,
    rows: attaching ? args.rows : undefined,
    cols: attaching ? args.cols : undefined,
    detachable: args.detachable,
    cc: args.cc,
    max_run_after_disconnect: args.max_run_after_disconnect,
  };
  const channel = await connect(
    ctx,
    spritePath(ctx, attaching ? `/exec/${segment(args.session_id)}` : "/exec"),
    query,
  );
  const stdout: Uint8Array[] = [], stderr: Uint8Array[] = [];
  const controls: z.output<typeof ExecControl>[] = [];
  let totalBytes = 0;
  let tty = args.tty;
  let sessionId: string | null = attaching ? args.session_id : null;
  let exitCode: number | null = null;
  let detached = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const { promise: actionFailure, reject: rejectAction } = Promise
    .withResolvers<never>();
  let ready = !attaching;
  const scrollback: Uint8Array[] = [];
  const receiveBinary = (bytes: Uint8Array): void => {
    if (tty) stdout.push(bytes);
    else {
      const frame = decodeStreamFrame(bytes);
      if (frame.kind === "exit") exitCode = frame.code;
      else (frame.kind === "stdout" ? stdout : stderr).push(frame.data);
    }
  };
  const sendInput = async (data: Uint8Array): Promise<void> => {
    await channel.send(stdinFrame(tty, data));
  };
  const startActions = async (): Promise<void> => {
    if (
      attaching && tty && args.rows !== undefined && args.cols !== undefined
    ) {
      await channel.send(
        JSON.stringify({ type: "resize", rows: args.rows, cols: args.cols }),
      );
    }
    if (args.input) await sendInput(inputBytes(args.input));
    if (
      args.closeStdin && !tty &&
      !args.actions.some((action) =>
        action.type === "stdin" || action.type === "eof"
      )
    ) await channel.send(EOF_FRAME);
    for (const action of args.actions) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        const perform = async (): Promise<void> => {
          if (action.type === "stdin") {
            await sendInput(inputBytes(action.input));
          } else if (action.type === "eof") {
            if (!tty) await channel.send(EOF_FRAME);
          } else if (action.type === "resize") {
            if (!tty) throw new Error("Resize requires a TTY session.");
            await channel.send(
              JSON.stringify({
                type: "resize",
                cols: action.cols,
                rows: action.rows,
              }),
            );
          } else {await channel.send(
              JSON.stringify({ type: "signal", signal: action.signal }),
            );}
        };
        perform().catch(rejectAction);
      }, action.atMs);
      timers.add(timer);
    }
  };
  let stop: ReturnType<typeof setTimeout> | undefined;
  const detach = new Promise<null>((resolve) => {
    if (args.detachAfterMs !== undefined) {
      stop = setTimeout(() => {
        detached = true;
        resolve(null);
      }, args.detachAfterMs);
    }
  });
  try {
    if (ready) await startActions();
    while (exitCode === null && !detached) {
      const message = await Promise.race([
        channel.read(),
        actionFailure,
        detach,
      ]);
      if (!message) break;
      totalBytes += message.bytes.length;
      if (totalBytes > ctx.globalArgs.maxResponseBytes) {
        throw new Error(
          "Exec output exceeded maxResponseBytes; no complete result was saved.",
        );
      }
      if (!message.binary) {
        const value = decodeFrame(
          message.bytes,
          ExecControl,
          "Exec returned an invalid JSON control frame.",
        );
        controls.push(value);
        if (value.type === "error" || ("error" in value && value.error)) {
          throw new Error("Exec reported a protocol error.");
        }
        if (value.type === "session_info") {
          if (value.session_id === undefined || value.tty === undefined) {
            throw new Error("Exec session_info omitted session_id or tty.");
          }
          if (attaching && value.session_id !== args.session_id) {
            throw new Error("Exec attached to an unexpected session.");
          }
          sessionId = value.session_id;
          tty = value.tty;
          if (!ready) {
            ready = true;
            for (const bytes of scrollback) receiveBinary(bytes);
            scrollback.length = 0;
            if (exitCode === null) await startActions();
          }
        }
        if (value.type === "exit") {
          exitCode = value.exit_code;
        }
      } else {
        if (!ready) scrollback.push(message.bytes);
        else receiveBinary(message.bytes);
      }
    }
    if (detached && !sessionId) {
      throw new Error(
        "Exec detached before receiving a session identity; inspect sessions before retrying.",
      );
    }
    if (!detached && exitCode === null) {
      throw new Error(
        "Exec disconnected without an exit frame; inspect the session before retrying.",
      );
    }
    return {
      stdout: concatenate(stdout),
      stderr: concatenate(stderr),
      exitCode,
      sessionId,
      controls,
      status: detached && exitCode === null ? "detached" : "exited",
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (stop !== undefined) clearTimeout(stop);
    await channel.close();
  }
}

/** Persist bytes only after the command protocol finishes successfully. */
export async function saveExecution(
  ctx: SpriteContext,
  result: SocketResult,
  failOnNonZero: boolean,
) {
  if (failOnNonZero && result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(
      `Sprite command exited with code ${result.exitCode}. Set failOnNonZero=false to save its stdout and stderr for inspection.`,
    );
  }
  ctx.signal.throwIfAborted();
  const data = {
    status: result.status,
    exitCode: result.exitCode,
    sessionId: result.sessionId,
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
    controls: result.controls,
  };
  const stdout = await ctx.createFileWriter("stdout", "stdout").writeAll(
    result.stdout,
  );
  const stderr = await ctx.createFileWriter("stderr", "stderr").writeAll(
    result.stderr,
  );
  return withHandles(data, [stdout, stderr]);
}
/** Exec output declarations. */
export const execResources = {
  execution: resource(
    Execution,
    "Command result or detached session identity",
    "7d",
  ),
  sessions: resource(Sessions, "Exec sessions", "7d"),
  sessionKilled: resource(Killed, "Session termination progress", "7d"),
};
/** Separate binary stdout/stderr files avoid encoding loss. */
export const execFiles = { stdout: BinaryFile, stderr: BinaryFile };
/** All HTTP and WebSocket execution methods. */
export const execMethods = {
  exec: method(
    "Execute a command over WebSocket with binary output and optional TTY controls",
    ExecArgs,
    "execution",
    Execution,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await saveExecution(
        ctx,
        await executeSocket(ctx, args),
        args.failOnNonZero,
      );
    },
  ),
  attach: method(
    "Attach to an existing exec session and exchange input, output, and controls",
    AttachArgs,
    "execution",
    Execution,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await saveExecution(
        ctx,
        await executeSocket(ctx, args),
        args.failOnNonZero,
      );
    },
  ),
  execHttp: method(
    "Execute over HTTP/1.1 while preserving provider chunk framing",
    CommandArgs,
    "execution",
    Execution,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      const result = await executeHttp(ctx, {
        cmd: args.cmd,
        path: args.path,
        dir: args.dir,
        env: envPairs(args.env),
        stdin: args.input !== undefined,
      }, inputBytes(args.input));
      return await saveExecution(ctx, {
        ...result,
        status: "exited",
        sessionId: null,
        controls: [],
      }, args.failOnNonZero);
    },
  ),
  listSessions: method(
    "List exec sessions",
    z.object({}),
    "sessions",
    Sessions,
    async (_args, ctx: SpriteContext) =>
      await jsonRequest(
        ctx,
        "GET",
        spritePath(ctx, "/exec"),
        Sessions,
      ),
  ),
  killSession: method(
    "Kill an exec session",
    z.object({
      session_id: z.string().min(1),
      signal: z.string().optional(),
      timeout: z.string().optional(),
    }),
    "sessionKilled",
    Killed,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      const events = await ndjson(
        ctx,
        "POST",
        spritePath(ctx, `/exec/${segment(args.session_id)}/kill`),
        KillEvent,
        { query: { signal: args.signal, timeout: args.timeout } },
      );
      if (!events.some((event) => event.type === "complete")) {
        throw new Error(
          "Session kill stream ended without completion.",
        );
      }
      return { events };
    },
  ),
};
