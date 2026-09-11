// SPDX-License-Identifier: MIT
/** Bounded sequential exec operations over a persistent control channel. @module */
import { z } from "zod";
import {
  BinaryFile,
  concatenate,
  deadline,
  inputBytes,
  method,
  resource,
  withHandles,
} from "./core.ts";
import { ExecArgs } from "./exec.ts";
import { type Channel, type ConnectChannel, openChannel } from "./socket.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite-api.ts";
import { decodeStreamFrame } from "./exec-http.ts";
import { initializeTerminal } from "./terminal.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const CONTROL_PREFIX = "control:";

/** Control exec accepts only fields implemented by the native control protocol. */
export const ControlExecOperationArgs = ExecArgs.pick({
  cmd: true,
  dir: true,
  env: true,
  input: true,
  failOnNonZero: true,
  tty: true,
  rows: true,
  cols: true,
  closeStdin: true,
  actions: true,
}).strict();
/** One control connection runs a bounded, non-overlapping operation sequence. */
export const ControlExecArgs = z.object({
  operations: z.array(ControlExecOperationArgs).min(1).max(100),
});

const OperationMetadata = z.object({
  operation: z.number().int().min(1),
  exitCode: z.number().int(),
  tty: z.boolean(),
  stdoutOffset: z.number().int().nonnegative(),
  stdoutLength: z.number().int().nonnegative(),
  stderrOffset: z.number().int().nonnegative(),
  stderrLength: z.number().int().nonnegative(),
});
const ControlExecution = z.object({
  operationCount: z.number().int().min(1).max(100),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  operations: z.array(OperationMetadata).min(1).max(100),
});
const Completion = z.object({
  type: z.literal("op.complete"),
  op: z.literal("exec").optional(),
  args: z.object({ exitCode: z.number().int().optional() }).optional(),
});
const OperationError = z.object({
  type: z.literal("op.error"),
  op: z.literal("exec").optional(),
  args: z.object({ error: z.string().optional() }).optional(),
});
const OperationMessage = z.union([
  z.object({ type: z.literal("exit"), exit_code: z.number().int() }),
  z.object({
    type: z.enum(["session_info", "port_opened", "port_closed", "debug"]),
    tty: z.boolean().optional(),
  }),
]);
const ServerControl = z.discriminatedUnion("type", [
  Completion,
  OperationError,
]);

type Operation = z.output<typeof ControlExecOperationArgs>;
export type ControlOperationMetadata = z.output<typeof OperationMetadata>;
/** Fully decoded result returned before any Swamp output is written. */
export type ControlExecResult = {
  operations: ControlOperationMetadata[];
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type Action = Operation["actions"][number];
type AbortResult = { type: "abort" };
type RaceResult =
  | { type: "message"; message: Awaited<ReturnType<Channel["read"]>> }
  | { type: "wake" }
  | AbortResult;

const TIMEOUT_MESSAGE = "Control exec was cancelled or exceeded timeoutMs.";

function validateOperation(operation: Operation): void {
  if (
    !operation.tty &&
    (operation.rows !== undefined || operation.cols !== undefined)
  ) {
    throw new Error("Control exec rows and cols require a TTY operation.");
  }
  const ordered = operation.actions.map((action, index) => ({ action, index }))
    .sort((left, right) =>
      left.action.atMs - right.action.atMs || left.index - right.index
    );
  let eof = false;
  for (const { action } of ordered) {
    if (action.type === "resize" && !operation.tty) {
      throw new Error("Control exec resize requires a TTY operation.");
    }
    if (action.type === "eof" && operation.tty) {
      throw new Error("Control exec EOF is unsupported for TTY operations.");
    }
    if (action.type === "eof") {
      if (eof) throw new Error("Control exec accepts at most one EOF action.");
      eof = true;
    } else if (action.type === "stdin" && eof) {
      throw new Error("Control exec cannot send stdin after EOF.");
    }
  }
}

function startFrame(operation: Operation): string {
  const hasStdin = operation.input !== undefined ||
    operation.actions.some((action) =>
      action.type === "stdin" || action.type === "eof"
    );
  const command = operation.tty
    ? initializeTerminal({ cmd: operation.cmd }, operation.rows, operation.cols)
    : { cmd: operation.cmd };
  const args: Record<string, string | string[]> = {
    cmd: command.cmd,
    env: Object.entries(operation.env ?? {}).map(([name, value]) =>
      `${name}=${value}`
    ),
    stdin: hasStdin ? "true" : "false",
  };
  if (operation.dir !== undefined) args.dir = operation.dir;
  if (operation.tty) args.tty = "true";
  return CONTROL_PREFIX + JSON.stringify({
    type: "op.start",
    op: "exec",
    args,
  });
}

function parseControl(
  bytes: Uint8Array,
): z.output<typeof ServerControl> | z.output<typeof OperationMessage> {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error("Control exec returned invalid UTF-8 text.");
  }
  const envelope = text.startsWith(CONTROL_PREFIX);
  let value: unknown;
  try {
    value = JSON.parse(envelope ? text.slice(CONTROL_PREFIX.length) : text);
  } catch {
    throw new Error("Control exec returned malformed control JSON.");
  }
  const parsed = envelope
    ? ServerControl.safeParse(value)
    : OperationMessage.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Control exec returned an unsupported ${
        envelope ? "control" : "text"
      } frame.`,
    );
  }
  return parsed.data;
}

async function sendAction(
  channel: Channel,
  operation: Operation,
  action: Action,
  abort: Promise<AbortResult>,
  budget: ReturnType<typeof deadline>,
): Promise<void> {
  let payload: Uint8Array | string;
  if (action.type === "stdin") {
    const bytes = await inputBytes(action.input);
    payload = operation.tty ? bytes : concatenate([new Uint8Array([0]), bytes]);
  } else if (action.type === "eof") {
    payload = new Uint8Array([4]);
  } else if (action.type === "resize") {
    payload = JSON.stringify({
      type: "resize",
      cols: action.cols,
      rows: action.rows,
    });
  } else {
    payload = JSON.stringify({
      type: "signal",
      signal: action.signal,
    });
  }
  budget.check(TIMEOUT_MESSAGE);
  const outcome = await Promise.race([
    channel.send(payload).then(() => ({ type: "action" } as const)),
    abort,
  ]);
  if (outcome.type === "abort") throw new Error(TIMEOUT_MESSAGE);
}

async function runOperation(
  channel: Channel,
  operation: Operation,
  account: (length: number) => void,
  abort: Promise<AbortResult>,
  budget: ReturnType<typeof deadline>,
): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
  const frame = startFrame(operation);
  budget.check(TIMEOUT_MESSAGE);
  await Promise.race([
    channel.send(frame).then(
      () => ({ type: "action" } as const),
    ),
    abort,
  ]).then((outcome) => {
    if (outcome.type === "abort") throw new Error(TIMEOUT_MESSAGE);
  });
  budget.check(TIMEOUT_MESSAGE);
  const started = performance.now();
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let nativeExit: number | undefined;
  const exitSources = new Set<"binary" | "json">();
  const recordExit = (source: "binary" | "json", code: number): number => {
    if (exitSources.has(source)) {
      throw new Error("Control exec returned a duplicate exit frame.");
    }
    if (nativeExit !== undefined && nativeExit !== code) {
      throw new Error("Control exec returned conflicting exit statuses.");
    }
    exitSources.add(source);
    return code;
  };
  const actions = operation.actions.map((action, index) => ({ action, index }))
    .sort((left, right) =>
      left.action.atMs - right.action.atMs || left.index - right.index
    )
    .map(({ action }) => action);
  let actionIndex = 0;
  const sendInput = async (bytes: Uint8Array): Promise<void> => {
    budget.check(TIMEOUT_MESSAGE);
    const payload = operation.tty
      ? bytes
      : concatenate([new Uint8Array([0]), bytes]);
    const outcome = await Promise.race([
      channel.send(payload).then(() => ({ type: "action" } as const)),
      abort,
    ]);
    if (outcome.type === "abort") throw new Error(TIMEOUT_MESSAGE);
    budget.check(TIMEOUT_MESSAGE);
  };
  if (operation.input !== undefined) {
    await sendInput(await inputBytes(operation.input));
  }
  if (
    operation.input !== undefined && operation.closeStdin && !operation.tty &&
    !operation.actions.some((action) =>
      action.type === "stdin" || action.type === "eof"
    )
  ) {
    await sendAction(
      channel,
      operation,
      { type: "eof", atMs: 0 },
      abort,
      budget,
    );
  }

  let pendingRead = channel.read();
  while (true) {
    budget.check(TIMEOUT_MESSAGE);
    const nextAction = actions[actionIndex];
    const actionRemaining = nextAction === undefined
      ? Number.POSITIVE_INFINITY
      : nextAction.atMs - (performance.now() - started);
    if (nextAction !== undefined && actionRemaining <= 0) {
      await sendAction(
        channel,
        operation,
        nextAction,
        abort,
        budget,
      );
      actionIndex++;
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineRemaining = budget.remainingMs();
    const wake = nextAction === undefined
      ? new Promise<RaceResult>(() => {})
      : new Promise<RaceResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ type: "wake" }),
          Math.min(actionRemaining, deadlineRemaining, 2_147_483_647),
        );
      });
    let outcome: RaceResult;
    try {
      outcome = await Promise.race([
        pendingRead.then((message) => ({ type: "message", message } as const)),
        wake,
        abort,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (outcome.type === "abort") throw new Error(TIMEOUT_MESSAGE);
    budget.check(TIMEOUT_MESSAGE);
    if (outcome.type === "wake") continue;
    const message = outcome.message;
    if (message === null) {
      throw new Error(
        "Control exec connection closed before op.complete; inspect the Sprite before retrying.",
      );
    }
    account(message.bytes.length);
    if (message.binary) {
      if (operation.tty) {
        stdout.push(message.bytes);
      } else {
        const frame = decodeStreamFrame(message.bytes);
        if (frame.kind === "exit") {
          nativeExit = recordExit("binary", frame.code);
          actionIndex = actions.length;
        } else {
          if (nativeExit !== undefined) {
            throw new Error(
              "Control exec returned output after its exit frame.",
            );
          }
          (frame.kind === "stdout" ? stdout : stderr).push(frame.data);
        }
      }
      pendingRead = channel.read();
      continue;
    }
    const control = parseControl(message.bytes);
    if (control.type === "op.error") {
      throw new Error(
        "Control exec reported an operation error; no partial output was saved.",
      );
    }
    if (control.type === "exit") {
      nativeExit = recordExit("json", control.exit_code);
      actionIndex = actions.length;
      pendingRead = channel.read();
      continue;
    }
    if (control.type !== "op.complete") {
      if (control.tty !== undefined && control.tty !== operation.tty) {
        throw new Error("Control exec returned a mismatched TTY mode.");
      }
      pendingRead = channel.read();
      continue;
    }
    const completedExit = control.args?.exitCode;
    if (
      nativeExit !== undefined && completedExit !== undefined &&
      nativeExit !== completedExit
    ) {
      throw new Error("Control exec returned conflicting exit statuses.");
    }
    const exitCode = nativeExit ?? completedExit;
    if (exitCode === undefined) {
      throw new Error("Control exec completed without an exit status.");
    }
    const result = {
      stdout: concatenate(stdout),
      stderr: concatenate(stderr),
      exitCode,
    };
    return result;
  }
}

/** Run exec operations sequentially on one authenticated persistent WebSocket. */
export async function executeControl(
  ctx: SpriteContext,
  args: z.output<typeof ControlExecArgs>,
  connect: ConnectChannel = openChannel,
): Promise<ControlExecResult> {
  for (const operation of args.operations) validateOperation(operation);
  const budget = deadline(ctx);
  const { signal } = budget;
  let channel: Channel | undefined;
  let onAbort: (() => void) | undefined;
  try {
    budget.check(TIMEOUT_MESSAGE);
    channel = await connect(
      { ...ctx, signal },
      spritePath(ctx, "/control"),
    );
    budget.check(TIMEOUT_MESSAGE);
    let received = 0;
    const account = (length: number): void => {
      received += length;
      if (received > ctx.globalArgs.maxResponseBytes) {
        throw new Error(
          "Control exec exceeded maxResponseBytes across the operation sequence; no output was saved.",
        );
      }
    };
    let resolveAbort: (value: AbortResult) => void = () => {};
    const abort = new Promise<AbortResult>((resolve) => {
      resolveAbort = resolve;
    });
    onAbort = (): void => {
      resolveAbort({ type: "abort" });
      void channel?.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const operations: ControlOperationMetadata[] = [];
    let stdoutOffset = 0;
    let stderrOffset = 0;
    for (let index = 0; index < args.operations.length; index++) {
      const operation = args.operations[index];
      const result = await runOperation(
        channel,
        operation,
        account,
        abort,
        budget,
      );
      budget.check(TIMEOUT_MESSAGE);
      if (operation.failOnNonZero && result.exitCode !== 0) {
        throw new Error(
          `Control exec operation ${
            index + 1
          } exited with code ${result.exitCode}; no batch output was saved.`,
        );
      }
      operations.push({
        operation: index + 1,
        exitCode: result.exitCode,
        tty: operation.tty,
        stdoutOffset,
        stdoutLength: result.stdout.length,
        stderrOffset,
        stderrLength: result.stderr.length,
      });
      stdout.push(result.stdout);
      stderr.push(result.stderr);
      stdoutOffset += result.stdout.length;
      stderrOffset += result.stderr.length;
    }
    const result = {
      operations,
      stdout: concatenate(stdout),
      stderr: concatenate(stderr),
    };
    return result;
  } finally {
    budget.dispose();
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    await channel?.close();
  }
}

/** Persist aggregate binary streams and per-operation byte ranges after full success. */
export async function saveControlExecution(
  ctx: SpriteContext,
  result: ControlExecResult,
) {
  ctx.signal.throwIfAborted();
  const data = {
    operationCount: result.operations.length,
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
    operations: result.operations,
  };
  const stdout = await ctx.createFileWriter("controlStdout", "controlStdout")
    .writeAll(result.stdout);
  const stderr = await ctx.createFileWriter("controlStderr", "controlStderr")
    .writeAll(result.stderr);
  return withHandles(data, [stdout, stderr]);
}

/** Seven-day exec-batch metadata; this does not claim proxy control coverage. */
export const controlResources = {
  controlExecution: resource(
    ControlExecution,
    "Sequential control-channel exec result and artifact byte ranges",
    "7d",
  ),
};
/** Fixed aggregate names avoid dynamic artifact-spec violations. */
export const controlFiles = {
  controlStdout: BinaryFile,
  controlStderr: BinaryFile,
};
/** Persistent control-channel methods limited to the exec operation. */
export const controlMethods = {
  controlExec: method(
    "Run bounded sequential exec operations over one persistent WebSocket",
    ControlExecArgs,
    "controlExecution",
    ControlExecution,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await saveControlExecution(ctx, await executeControl(ctx, args));
    },
  ),
};
