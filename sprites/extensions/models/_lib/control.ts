// SPDX-License-Identifier: MIT
/** Bounded sequential exec operations over a persistent control channel. @module */
import { z } from "npm:zod@4.4.3";
import {
  BinaryFile,
  concatenate,
  deadline,
  decodeFrame,
  inputBytes,
  method,
  resource,
  withHandles,
} from "./core.ts";
import { ExecArgs, ExecControl } from "./exec.ts";
import { type Channel, type ConnectChannel, openChannel } from "./socket.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite.ts";
import { decodeStreamFrame, envPairs, EOF_FRAME, stdinFrame } from "./exec.ts";
import { initializeTerminal } from "./exec.ts";

const CONTROL_PREFIX = "control:";
const CONTROL_PREFIX_BYTES = new TextEncoder().encode(CONTROL_PREFIX);

/** Control exec accepts only fields implemented by the native control protocol. */
// ExecArgs carries a refinement, so zod refuses pick(); list the shared fields.
export const ControlExecOperationArgs = z.object({
  cmd: ExecArgs.shape.cmd,
  dir: ExecArgs.shape.dir,
  env: ExecArgs.shape.env,
  input: ExecArgs.shape.input,
  failOnNonZero: ExecArgs.shape.failOnNonZero,
  tty: ExecArgs.shape.tty,
  rows: ExecArgs.shape.rows,
  cols: ExecArgs.shape.cols,
  closeStdin: ExecArgs.shape.closeStdin,
  actions: ExecArgs.shape.actions.transform((actions) =>
    actions.toSorted((a, b) => a.atMs - b.atMs)
  ),
}).strict().superRefine((operation, ctx) => {
  const issue = (message: string): void =>
    ctx.addIssue({ code: "custom", message });
  if (
    !operation.tty &&
    (operation.rows !== undefined || operation.cols !== undefined)
  ) {
    issue("Control exec rows and cols require a TTY operation.");
  }
  let eof = false;
  for (const action of operation.actions) {
    if (action.type === "resize" && !operation.tty) {
      issue("Control exec resize requires a TTY operation.");
    }
    if (action.type === "eof" && operation.tty) {
      issue("Control exec EOF is unsupported for TTY operations.");
    }
    if (action.type === "eof") {
      if (eof) issue("Control exec accepts at most one EOF action.");
      eof = true;
    } else if (action.type === "stdin" && eof) {
      issue("Control exec cannot send stdin after EOF.");
    }
  }
});
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
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  operations: z.array(OperationMetadata).min(1).max(100),
});
const ServerControl = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("op.complete"),
    op: z.literal("exec").optional(),
    args: z.object({ exitCode: z.number().int().optional() }).optional(),
  }),
  z.object({
    type: z.literal("op.error"),
    op: z.literal("exec").optional(),
  }),
]);

type Operation = z.output<typeof ControlExecOperationArgs>;
export type ControlOperationMetadata = z.output<typeof OperationMetadata>;
/** Fully decoded result returned before any Swamp output is written. */
export type ControlExecResult = {
  operations: ControlOperationMetadata[];
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type RaceResult =
  | { type: "message"; message: Awaited<ReturnType<Channel["read"]>> }
  | { type: "wake" };

const TIMEOUT_MESSAGE = "Control exec was cancelled or exceeded timeoutMs.";

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
    env: envPairs(operation.env),
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

function decodeControl(bytes: Uint8Array) {
  const envelope = CONTROL_PREFIX_BYTES.every((byte, index) =>
    bytes[index] === byte
  );
  return envelope
    ? decodeFrame(
      bytes.subarray(CONTROL_PREFIX_BYTES.length),
      ServerControl,
      "Control exec returned an unsupported control frame.",
    )
    : decodeFrame(
      bytes,
      ExecControl,
      "Control exec returned an unsupported text frame.",
    );
}

async function runOperation(
  channel: Channel,
  operation: Operation,
  account: (length: number) => void,
  abort: Promise<never>,
  budget: ReturnType<typeof deadline>,
): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
  const send = async (payload: string | Uint8Array): Promise<void> => {
    budget.check(TIMEOUT_MESSAGE);
    await Promise.race([channel.send(payload), abort]);
    budget.check(TIMEOUT_MESSAGE);
  };
  async function sendAction(
    action: Operation["actions"][number],
  ): Promise<void> {
    let payload: Uint8Array | string;
    if (action.type === "stdin") {
      payload = stdinFrame(operation.tty, inputBytes(action.input));
    } else if (action.type === "eof") {
      payload = EOF_FRAME;
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
    await send(payload);
  }
  await send(startFrame(operation));
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
  let actionIndex = 0;
  if (operation.input !== undefined) {
    await sendAction({ type: "stdin", atMs: 0, input: operation.input });
  }
  if (
    operation.input !== undefined && operation.closeStdin && !operation.tty &&
    !operation.actions.some((action) =>
      action.type === "stdin" || action.type === "eof"
    )
  ) {
    await sendAction({ type: "eof", atMs: 0 });
  }

  let pendingRead = channel.read();
  while (true) {
    budget.check(TIMEOUT_MESSAGE);
    const nextAction = operation.actions[actionIndex];
    const actionRemaining = nextAction === undefined
      ? Number.POSITIVE_INFINITY
      : nextAction.atMs - (performance.now() - started);
    if (nextAction !== undefined && actionRemaining <= 0) {
      await sendAction(nextAction);
      actionIndex++;
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = nextAction === undefined
      ? new Promise<RaceResult>(() => {})
      : new Promise<RaceResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ type: "wake" }),
          Math.min(actionRemaining, budget.remainingMs(), 2_147_483_647),
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
          actionIndex = operation.actions.length;
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
    const control = decodeControl(message.bytes);
    if (control.type === "op.error" || control.type === "error") {
      throw new Error(
        "Control exec reported an operation error; no partial output was saved.",
      );
    }
    if (control.type === "exit") {
      nativeExit = recordExit("json", control.exit_code);
      actionIndex = operation.actions.length;
      pendingRead = channel.read();
      continue;
    }
    if (control.type !== "op.complete") {
      if (
        "tty" in control && control.tty !== undefined &&
        control.tty !== operation.tty
      ) {
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
    return {
      stdout: concatenate(stdout),
      stderr: concatenate(stderr),
      exitCode,
    };
  }
}

/** Run exec operations sequentially on one authenticated persistent WebSocket. */
export async function executeControl(
  ctx: SpriteContext,
  args: z.output<typeof ControlExecArgs>,
  connect: ConnectChannel = openChannel,
): Promise<ControlExecResult> {
  const budget = deadline(ctx);
  const { signal } = budget;
  let channel: Channel | undefined;
  let onAbort: (() => void) | undefined;
  try {
    budget.check(TIMEOUT_MESSAGE);
    channel = await connect(
      { ...ctx, signal },
      spritePath(ctx.globalArgs.name, "/control"),
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
    const { promise: abort, reject: rejectAbort } = Promise.withResolvers<
      never
    >();
    void abort.catch(() => {});
    onAbort = (): void => {
      rejectAbort(new Error(TIMEOUT_MESSAGE));
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
    return {
      operations,
      stdout: concatenate(stdout),
      stderr: concatenate(stderr),
    };
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
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
    operations: result.operations,
  };
  const stdout = await ctx.createFileWriter(
    "controlExecStdout",
    "controlExecStdout",
  )
    .writeAll(result.stdout);
  const stderr = await ctx.createFileWriter(
    "controlExecStderr",
    "controlExecStderr",
  )
    .writeAll(result.stderr);
  return withHandles(data, [stdout, stderr]);
}

/** Seven-day exec-batch metadata; this does not claim proxy control coverage. */
export const controlResources = {
  controlExec: resource(
    ControlExecution,
    "Sequential control-channel exec result and artifact byte ranges",
    "7d",
  ),
};
/** Fixed aggregate names avoid dynamic artifact-spec violations. */
export const controlFiles = {
  controlExecStdout: BinaryFile,
  controlExecStderr: BinaryFile,
};
/** Persistent control-channel methods limited to the exec operation. */
export const controlMethods = {
  controlExec: method(
    "Run bounded sequential exec operations over one persistent WebSocket",
    ControlExecArgs,
    "controlExec",
    ControlExecution,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      return await saveControlExecution(ctx, await executeControl(ctx, args));
    },
  ),
};
