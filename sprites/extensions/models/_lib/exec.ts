// SPDX-License-Identifier: MIT
/** Command execution over HTTP and WebSocket, terminal sizing, and session lifecycle. @module */
import { z } from "zod";
import {
  apiUrl,
  BinaryFile,
  concatenate,
  type Context,
  decodeFrame,
  Input,
  inputBytes,
  jsonRequest,
  method,
  ndjson,
  type Query,
  resource,
  segment,
  withHandles,
} from "./core.ts";
import { type ConnectChannel, openChannel } from "./socket.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite.ts";
import { connect as connectTls } from "node:tls";
import { Readable } from "node:stream";

/** A terminal dimension that fits the kernel's unsigned 16-bit winsize field. */
export const TerminalDimension = z.number().int().min(1).max(65_535);
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

/** Sprite's native Python, isolated from the command environment's import paths. */
export const TERMINAL_PYTHON = "/.sprite/bin/python3";

/** Set the new PTY's initial winsize, then replace the initializer process. */
export const TERMINAL_PROGRAM = String.raw`import os,sys,fcntl,struct,termios
try:
 fd=next(fd for fd in (0,1,2) if os.isatty(fd))
 size=fcntl.ioctl(fd,termios.TIOCGWINSZ,b"\0"*8)
 rows,cols,xpixel,ypixel=struct.unpack("HHHH",size)
 if sys.argv[1]: rows=int(sys.argv[1])&0xffff
 if sys.argv[2]: cols=int(sys.argv[2])&0xffff
 fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",rows,cols,xpixel,ypixel))
except BaseException:
 os.write(2,b"terminal initialization failed\n")
 os._exit(126)
try:
 os.execvpe(sys.argv[3],sys.argv[4:],os.environ)
except BaseException:
 os.write(2,b"command execution failed\n")
 os._exit(127)`;

export type TerminalCommand = {
  cmd: string[];
  path?: string;
};

/** Wrap a new TTY command only when an initial dimension was supplied. */
export function initializeTerminal(
  command: TerminalCommand,
  rows: number | undefined,
  cols: number | undefined,
): TerminalCommand {
  if (rows === undefined && cols === undefined) return command;
  return {
    cmd: [
      TERMINAL_PYTHON,
      "-I",
      "-c",
      TERMINAL_PROGRAM,
      String(rows ?? ""),
      String(cols ?? ""),
      command.path ?? command.cmd[0],
      ...command.cmd,
    ],
    path: TERMINAL_PYTHON,
  };
}
/** Command results preserve raw stdout and stderr separately. */
export type CommandResult = {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
};
class WireReader {
  private buffer: Uint8Array = new Uint8Array();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async exact(length: number): Promise<Uint8Array> {
    while (this.buffer.length < length) {
      const next = await this.reader.read();
      if (next.done) {
        throw new Error(
          "HTTP exec response ended before the frame was complete.",
        );
      }
      this.buffer = concatenate([this.buffer, next.value]);
    }
    const value = this.buffer.slice(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }
  async line(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 16_384) {
      const byte = (await this.exact(1))[0];
      if (byte === 10) {
        if (bytes.pop() !== 13) {
          throw new Error("HTTP exec response has malformed line endings.");
        }
        return new TextDecoder().decode(new Uint8Array(bytes));
      }
      bytes.push(byte);
    }
    throw new Error("HTTP exec header exceeds 16 KiB.");
  }
  async close(): Promise<void> {
    await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
  }
}

/** Decode actual HTTP chunks, not arbitrary fetch/ReadableStream chunks. */
export async function decodeHttpExec(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<CommandResult> {
  const reader = new WireReader(stream);
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let exitCode: number | undefined;
  let received = 0;
  try {
    let status: number;
    let headers: Headers;
    do {
      const line = await reader.line();
      const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(line);
      if (!match) {
        throw new Error("HTTP exec returned an invalid HTTP status line.");
      }
      status = Number(match[1]);
      headers = new Headers();
      let headerBytes = 0;
      while (true) {
        const header = await reader.line();
        headerBytes += header.length;
        if (headerBytes > 65_536) {
          throw new Error("HTTP exec response headers exceed 64 KiB.");
        }
        if (!header) break;
        const colon = header.indexOf(":");
        if (colon <= 0) {
          throw new Error("HTTP exec returned a malformed header.");
        }
        headers.append(header.slice(0, colon), header.slice(colon + 1).trim());
      }
    } while (status >= 100 && status < 200 && status !== 101);
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP exec returned HTTP ${status}.`);
    }
    if (headers.get("transfer-encoding")?.toLowerCase() !== "chunked") {
      throw new Error(
        "HTTP exec requires chunked HTTP/1.1 framing; use WebSocket exec for this endpoint.",
      );
    }
    if (
      headers.has("content-encoding") &&
      headers.get("content-encoding") !== "identity"
    ) throw new Error("HTTP exec response must not be compressed.");
    while (true) {
      const sizeText = (await reader.line()).split(";", 1)[0];
      if (!/^[0-9a-f]+$/i.test(sizeText)) {
        throw new Error("HTTP exec returned an invalid chunk size.");
      }
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size) || size > limit - received) {
        throw new Error(
          "HTTP exec exceeded maxResponseBytes; no complete result was saved.",
        );
      }
      if (!size) {
        let trailerBytes = 0;
        while (true) {
          const trailer = await reader.line();
          if (!trailer) break;
          trailerBytes += trailer.length;
          if (trailerBytes > 65_536) {
            throw new Error("HTTP exec trailers exceed 64 KiB.");
          }
        }
        break;
      }
      received += size;
      const frame = await reader.exact(size);
      if (await reader.line() !== "") {
        throw new Error("HTTP exec chunk lacks its ending CRLF.");
      }
      if (exitCode !== undefined) {
        throw new Error("HTTP exec sent data after its exit frame.");
      }
      const decoded = decodeStreamFrame(frame);
      if (decoded.kind === "stdout") stdout.push(decoded.data);
      else if (decoded.kind === "stderr") stderr.push(decoded.data);
      else if (decoded.kind === "exit") exitCode = decoded.code;
    }
    if (exitCode === undefined) {
      throw new Error("HTTP exec ended without an exit frame.");
    }
    return {
      stdout: concatenate(stdout),
      stderr: concatenate(stderr),
      exitCode,
    };
  } finally {
    await reader.close();
  }
}

/** Execute over TLS with HTTP/1.1 framing intact; never replay a command on failure. */
export async function executeHttp(
  ctx: Context,
  sprite: string,
  query: Query,
  input = new Uint8Array(),
  connect: typeof connectTls = connectTls,
): Promise<CommandResult> {
  const url = apiUrl(ctx.globalArgs, spritePath(sprite, "/exec"), query);
  const signal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(ctx.globalArgs.timeoutMs),
  ]);
  signal.throwIfAborted();
  const connection = connect({
    host: url.hostname,
    servername: url.hostname,
    port: Number(url.port || 443),
    rejectUnauthorized: true,
    ALPNProtocols: ["http/1.1"],
  });
  const close = (): void => {
    connection.destroy();
  };
  signal.addEventListener("abort", close, { once: true });
  // Keep an error listener for the socket's entire owned lifetime.
  connection.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        connection.off("secureConnect", ready);
        connection.off("error", failed);
        connection.off("close", closed);
      };
      const ready = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error("HTTP exec TLS handshake failed."));
      };
      const closed = (): void => {
        cleanup();
        reject(
          new Error(
            "HTTP exec TLS connection closed before its handshake completed.",
          ),
        );
      };
      connection.once("secureConnect", ready);
      connection.once("error", failed);
      connection.once("close", closed);
      if (signal.aborted) close();
    });
    signal.throwIfAborted();
    const header = new TextEncoder().encode(
      `POST ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${ctx.globalArgs.token}\r\nContent-Type: application/octet-stream\r\nAccept-Encoding: identity\r\nContent-Length: ${input.length}\r\nConnection: close\r\n\r\n`,
    );
    const write = (part: Uint8Array): Promise<void> =>
      new Promise((resolve, reject) =>
        connection.write(part, (error) =>
          error
            ? reject(
              new Error(
                "HTTP exec request write failed; inspect the remote session before retrying.",
              ),
            )
            : resolve())
      );
    const send = async (): Promise<void> => {
      await write(header);
      if (input.length) await write(input);
    };
    const stream = Readable.toWeb(connection) as ReadableStream<Uint8Array>;
    const [, result] = await Promise.all([
      send(),
      decodeHttpExec(stream, ctx.globalArgs.maxResponseBytes),
    ]);
    return result;
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

export function decodeStreamFrame(frame: Uint8Array):
  | { kind: "stdout" | "stderr"; data: Uint8Array }
  | { kind: "exit"; code: number } {
  if (frame[0] === 1 || frame[0] === 2) {
    return { kind: frame[0] === 1 ? "stdout" : "stderr", data: frame.slice(1) };
  }
  if (frame[0] === 3 && frame.length === 2) {
    return { kind: "exit", code: frame[1] };
  }
  throw new Error("Sprite exec stream returned an invalid frame.");
}

/** Encode stdin for the selected terminal mode. */
export function stdinFrame(tty: boolean, bytes: Uint8Array): Uint8Array {
  return tty ? bytes : concatenate([new Uint8Array([0]), bytes]);
}
/** Signal the end of standard input. */
export const EOF_FRAME = new Uint8Array([4]);
/** Encode environment entries for repeated API query parameters. */
export function envPairs(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`);
}
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
    spritePath(
      ctx.globalArgs.name,
      attaching ? `/exec/${segment(args.session_id)}` : "/exec",
    ),
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
  const sendInput = (data: Uint8Array): Promise<void> =>
    channel.send(stdinFrame(tty, data));
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
async function runSocket(
  ctx: SpriteContext,
  args: Parameters<typeof executeSocket>[1],
) {
  await verifySprite(ctx);
  return await saveExecution(
    ctx,
    await executeSocket(ctx, args),
    args.failOnNonZero,
  );
}
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
    (args, ctx: SpriteContext) => runSocket(ctx, args),
  ),
  attach: method(
    "Attach to an existing exec session and exchange input, output, and controls",
    AttachArgs,
    "execution",
    Execution,
    (args, ctx: SpriteContext) => runSocket(ctx, args),
  ),
  execHttp: method(
    "Execute over HTTP/1.1 while preserving provider chunk framing",
    CommandArgs,
    "execution",
    Execution,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      const result = await executeHttp(ctx, ctx.globalArgs.name, {
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
    (_args, ctx: SpriteContext) =>
      jsonRequest(
        ctx,
        "GET",
        spritePath(ctx.globalArgs.name, "/exec"),
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
        spritePath(
          ctx.globalArgs.name,
          `/exec/${segment(args.session_id)}/kill`,
        ),
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
