// SPDX-License-Identifier: MIT
import { concatenate, method } from "./core.ts";
import { z } from "zod";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import {
  AttachArgs,
  decodeHttpExec,
  decodeStreamFrame,
  envPairs,
  EOF_FRAME,
  ExecArgs,
  execResources,
  executeSocket,
  initializeTerminal,
  saveExecution,
  stdinFrame,
  TERMINAL_PROGRAM,
  TERMINAL_PYTHON,
} from "./exec.ts";
import { type ConnectChannel, type Message } from "./socket.ts";
import { SpriteArgsSchema, type SpriteContext } from "./sprite.ts";
import { binaryFrame, FakeChannel, textFrame } from "./test_support.ts";

const encoder = new TextEncoder();
function setup(messages: Message[]) {
  const globalArgs = SpriteArgsSchema.parse({
    token: "test-token",
    name: "worker",
  });
  const test = createModelTestContext({ globalArgs });
  const ctx: SpriteContext = {
    ...test.context,
    globalArgs,
    deleteResource: () => Promise.resolve(),
  };
  let connectedPath = "";
  let query: unknown;
  const channel = new FakeChannel([...messages, null]);
  const sent = channel.sent;
  const connect: ConnectChannel = (_ctx, path, value) => {
    connectedPath = path;
    query = value;
    return Promise.resolve(channel);
  };
  return {
    ...test,
    ctx,
    channel,
    connect,
    sent,
    closed: () => channel.closed,
    path: () => connectedPath,
    query: () => query,
  };
}
Deno.test("WebSocket exec preserves binary streams, repeated argv/env, stdin EOF, and exit status", async () => {
  const test = setup([
    textFrame({ type: "session_info", session_id: "7", tty: false }),
    binaryFrame(1, 0, 255),
    binaryFrame(2, 128),
    binaryFrame(3, 0),
  ]);
  const args = ExecArgs.parse({
    cmd: ["printf", "a b"],
    env: { FOO: "one two" },
    input: { kind: "base64", base64: "AP8=" },
  });
  const result = await executeSocket(test.ctx, args, test.connect);
  assertEquals(test.path(), "/v1/sprites/worker/exec");
  const query = test.query() as { cmd: string[]; env: string[] };
  assertEquals(query.cmd, ["printf", "a b"]);
  assertEquals(query.env, ["FOO=one two"]);
  assertEquals(test.sent, [new Uint8Array([0, 0, 255]), new Uint8Array([4])]);
  assertEquals(result.stdout, new Uint8Array([0, 255]));
  assertEquals(result.stderr, new Uint8Array([128]));
  assertEquals(result.exitCode, 0);
  assertEquals(result.sessionId, "7");
  assert(test.closed());
  const saved = await method(
    "Save execution",
    z.object({}),
    "exec",
    execResources.exec.schema,
    () => saveExecution(test.ctx, result, true, "exec"),
  ).execute({}, test.ctx);
  assertEquals(saved.dataHandles.map((handle) => handle.name), [
    "execStdout",
    "execStderr",
    "exec",
  ]);
  assertEquals(test.getWrittenFiles().length, 2);
  assertEquals(test.getWrittenResources()[0].data.stdoutBytes, 2);
});
Deno.test("direct exec preserves a delayed explicit EOF with default closeStdin", async () => {
  const test = setup([]);
  let finishRead: (message: Message) => void = () => {};
  test.channel.read = () =>
    new Promise<Message>((resolve) => {
      finishRead = resolve;
    });
  test.channel.send = (data) => {
    test.sent.push(data);
    finishRead(binaryFrame(3, 0));
    return Promise.resolve();
  };
  const originalTimeout = globalThis.setTimeout;
  const scheduled: { delay: number; run: () => void }[] = [];
  globalThis.setTimeout = new Proxy(originalTimeout, {
    apply(_target, _this, [handler, delay = 0]) {
      if (typeof handler !== "function") {
        throw new Error("Expected an action callback");
      }
      scheduled.push({ delay, run: () => handler() });
      return 0;
    },
  });
  try {
    const result = executeSocket(
      test.ctx,
      ExecArgs.parse({ cmd: ["cat"], actions: [{ type: "eof", atMs: 1000 }] }),
      test.connect,
    );
    // Allow async connection/setup to finish, without advancing the action clock.
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    assertEquals(test.sent, []);
    assertEquals(scheduled.map(({ delay }) => delay), [1000]);
    scheduled[0].run();
    assertEquals((await result).exitCode, 0);
    assertEquals(test.sent, [new Uint8Array([4])]);
    assert(test.closed());
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});

Deno.test("direct TTY initializes its size in the command before stdin", async () => {
  const test = setup([
    textFrame({ type: "session_info", session_id: "8", tty: true }),
    binaryFrame(0, 1),
    textFrame({ type: "exit", exit_code: 0 }),
  ]);
  const result = await executeSocket(
    test.ctx,
    ExecArgs.parse({
      cmd: ["display-name", "arg"],
      path: "/bin/sh",
      dir: "/work",
      env: { TERM: "xterm" },
      tty: true,
      rows: 24,
      cols: 80,
      input: { kind: "text", text: "echo ready\n" },
    }),
    test.connect,
  );
  assertEquals(test.sent, [encoder.encode("echo ready\n")]);
  const query = test.query() as {
    cmd: string[];
    path: string;
    dir: string;
    env: string[];
    rows?: number;
    cols?: number;
  };
  assertEquals(query.cmd.slice(0, 4), [
    TERMINAL_PYTHON,
    "-I",
    "-c",
    TERMINAL_PROGRAM,
  ]);
  assertEquals(query.cmd.slice(4), [
    "24",
    "80",
    "/bin/sh",
    "display-name",
    "arg",
  ]);
  assertEquals(query.path, TERMINAL_PYTHON);
  assertEquals(query.dir, "/work");
  assertEquals(query.env, ["TERM=xterm"]);
  assertEquals(query.rows, undefined);
  assertEquals(query.cols, undefined);
  assertEquals(result.stdout, new Uint8Array([0, 1]));
  assertEquals(result.exitCode, 0);
});
Deno.test("attachment takes TTY mode from session_info and handles JSON exit", async () => {
  const test = setup([
    binaryFrame(0, 1),
    textFrame({ type: "session_info", session_id: "42", tty: true }),
    binaryFrame(2, 255),
    textFrame({ type: "exit", exit_code: 9 }),
  ]);
  let reads = 0;
  const read = test.channel.read.bind(test.channel);
  test.channel.read = () => {
    reads++;
    return read();
  };
  test.channel.send = (data) => {
    assert(reads >= 2, "Attach controls must wait for session_info.");
    test.sent.push(data);
    return Promise.resolve();
  };
  const result = await executeSocket(
    test.ctx,
    AttachArgs.parse({
      session_id: "42",
      tty: true,
      rows: 24,
      cols: 80,
      input: { kind: "text", text: "help\n" },
      failOnNonZero: false,
    }),
    test.connect,
  );
  assertEquals(test.path(), "/v1/sprites/worker/exec/42");
  assertEquals(test.sent, [
    '{"type":"resize","rows":24,"cols":80}',
    encoder.encode("help\n"),
  ]);
  assertEquals(result.stdout, new Uint8Array([0, 1, 2, 255]));
  assertEquals(result.exitCode, 9);
  await assertRejects(
    () => saveExecution(test.ctx, result, true, "exec"),
    Error,
    "code 9",
  );
  assertEquals(test.getWrittenFiles(), []);
  await method(
    "Save execution",
    z.object({}),
    "attach",
    execResources.attach.schema,
    () => saveExecution(test.ctx, result, false, "attach"),
  ).execute({}, test.ctx);
  assertEquals(test.getWrittenResources()[0].data.exitCode, 9);
});
Deno.test("exec refuses disconnect without exit, bad frames, wrong session, and response overrun", async () => {
  for (
    const frames of [
      [],
      [binaryFrame(8, 0)],
      [
        textFrame({ type: "error", message: "provider-secret" }),
      ],
      [textFrame({ type: "exit" })],
      [textFrame({ type: "exit", exit_code: 0.5 })],
      [{
        binary: false,
        bytes: concatenate([
          encoder.encode('{"type":"debug","message":"'),
          new Uint8Array([255]),
          encoder.encode('"}'),
        ]),
      }],
    ]
  ) {
    const test = setup(frames);
    await assertRejects(() =>
      executeSocket(test.ctx, ExecArgs.parse({ cmd: ["test"] }), test.connect)
    );
    assert(test.closed());
  }
  const wrong = setup([
    textFrame({ type: "session_info", session_id: "wrong", tty: true }),
  ]);
  await assertRejects(
    () =>
      executeSocket(
        wrong.ctx,
        AttachArgs.parse({ session_id: "42" }),
        wrong.connect,
      ),
    Error,
    "unexpected session",
  );
  const large = setup([binaryFrame(1, 1, 2)]);
  large.ctx.globalArgs.maxResponseBytes = 2;
  await assertRejects(
    () =>
      executeSocket(
        large.ctx,
        ExecArgs.parse({ cmd: ["test"] }),
        large.connect,
      ),
    Error,
    "maxResponseBytes",
  );
});
Deno.test("exec rejects action and detach timers above the platform maximum", () => {
  assertEquals(
    ExecArgs.safeParse({ cmd: ["true"], tty: true, rows: 65_536 }).success,
    false,
  );
  assertEquals(
    ExecArgs.safeParse({
      cmd: ["true"],
      actions: [{ type: "resize", atMs: 0, rows: 1, cols: 65_536 }],
    }).success,
    false,
  );
  assertEquals(
    ExecArgs.safeParse({
      cmd: ["true"],
      actions: [{ type: "eof", atMs: 2_147_483_648 }],
    }).success,
    false,
  );
  assertEquals(
    ExecArgs.safeParse({ cmd: ["true"], detachAfterMs: 2_147_483_648 })
      .success,
    false,
  );
  assertEquals(
    AttachArgs.safeParse({
      session_id: "7",
      detachAfterMs: 2_147_483_648,
    }).success,
    false,
  );
});

Deno.test("exec can detach with a known session and cancels pending actions", async () => {
  const test = setup([
    textFrame({ type: "session_info", session_id: "7", tty: true }),
  ]);
  const originalRead = test.channel.read.bind(test.channel);
  let reads = 0;
  test.channel.read = () =>
    reads++ === 0 ? originalRead() : new Promise(() => {});
  const result = await executeSocket(
    test.ctx,
    ExecArgs.parse({
      cmd: ["bash"],
      tty: true,
      detachable: true,
      detachAfterMs: 5,
      actions: [{
        type: "stdin",
        atMs: 60_000,
        input: { kind: "text", text: "never sent" },
      }],
    }),
    test.connect,
  );
  assertEquals(result.status, "detached");
  assertEquals(result.exitCode, null);
  assertEquals(result.sessionId, "7");
  assertEquals(test.sent, []);
  assert(test.closed());
});
function httpWire(frames: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [
    encoder.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"),
  ];
  for (const frame of frames) {
    parts.push(
      encoder.encode(`${frame.length.toString(16)}\r\n`),
      frame,
      encoder.encode("\r\n"),
    );
  }
  parts.push(encoder.encode("0\r\nX-Result: done\r\n\r\n"));
  return concatenate(parts);
}
function stream(bytes: Uint8Array, step: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + step));
      offset += step;
    },
  });
}
Deno.test("HTTP exec reconstructs frames across arbitrary TLS fragmentation and coalescing", async () => {
  const bytes = httpWire([
    new Uint8Array([1, 0, 255]),
    new Uint8Array([2, 128]),
    new Uint8Array([3, 5]),
  ]);
  for (const size of [1, 2, 7, 4096]) {
    const result = await decodeHttpExec(stream(bytes, size), 1024);
    assertEquals(result, {
      stdout: new Uint8Array([0, 255]),
      stderr: new Uint8Array([128]),
      exitCode: 5,
    });
  }
});
Deno.test("HTTP exec rejects missing exit, malformed frames, truncation, and byte limits", async () => {
  await assertRejects(
    () => decodeHttpExec(stream(httpWire([new Uint8Array([1, 4])]), 3), 1024),
    Error,
    "exit frame",
  );
  await assertRejects(
    () =>
      decodeHttpExec(stream(httpWire([new Uint8Array([3, 1, 2])]), 3), 1024),
    Error,
    "invalid frame",
  );
  const bytes = httpWire([new Uint8Array([3, 0])]);
  await assertRejects(
    () => decodeHttpExec(stream(bytes.subarray(0, bytes.length - 8), 3), 1024),
    Error,
    "ended",
  );
  await assertRejects(
    () => decodeHttpExec(stream(bytes, 4096), 1),
    Error,
    "maxResponseBytes",
  );
});

Deno.test("exec dimensions require tty", () => {
  for (const dimensions of [{ rows: 24 }, { cols: 80 }]) {
    assertEquals(
      ExecArgs.safeParse({ cmd: ["true"], ...dimensions }).success,
      false,
    );
    assertEquals(
      AttachArgs.safeParse({ session_id: "1", ...dimensions }).success,
      false,
    );
    assertEquals(
      ExecArgs.safeParse({ cmd: ["true"], tty: true, ...dimensions }).success,
      true,
    );
  }
});

Deno.test("decodeStreamFrame separates binary output and exit status and rejects malformed frames", () => {
  assertEquals(decodeStreamFrame(new Uint8Array([1, 0, 255])), {
    kind: "stdout",
    data: new Uint8Array([0, 255]),
  });
  assertEquals(decodeStreamFrame(new Uint8Array([2, 128])), {
    kind: "stderr",
    data: new Uint8Array([128]),
  });
  assertEquals(decodeStreamFrame(new Uint8Array([3, 42])), {
    kind: "exit",
    code: 42,
  });
  for (const frame of [[], [0], [3], [3, 0, 0]]) {
    assertThrows(
      () => decodeStreamFrame(new Uint8Array(frame)),
      Error,
      "Sprite exec stream returned an invalid frame.",
    );
  }
});

Deno.test("stdinFrame prefixes non-TTY input and preserves TTY bytes", () => {
  const bytes = new Uint8Array([0, 255]);
  assertEquals(stdinFrame(false, bytes), new Uint8Array([0, 0, 255]));
  assertEquals(stdinFrame(true, bytes), bytes);
  assertEquals(stdinFrame(false, new Uint8Array()), new Uint8Array([0]));
});
Deno.test("EOF_FRAME signals the end of stdin", () => {
  assertEquals(EOF_FRAME, new Uint8Array([4]));
});
Deno.test("envPairs encodes values and accepts absent environments", () => {
  assertEquals(envPairs({ A: "a=b", EMPTY: "" }), ["A=a=b", "EMPTY="]);
  assertEquals(envPairs(undefined), []);
  assertEquals(envPairs({}), []);
});

Deno.test("terminal initializer preserves executable path separately from argv0", () => {
  const original = { cmd: ["display-name", "one", "two"], path: "/bin/tool" };
  const wrapped = initializeTerminal(original, 24, 80);
  assertEquals(wrapped.path, TERMINAL_PYTHON);
  assertEquals(wrapped.cmd.slice(0, 4), [
    TERMINAL_PYTHON,
    "-I",
    "-c",
    TERMINAL_PROGRAM,
  ]);
  assertEquals(wrapped.cmd.slice(4), [
    "24",
    "80",
    "/bin/tool",
    "display-name",
    "one",
    "two",
  ]);
  assertEquals(original, {
    cmd: ["display-name", "one", "two"],
    path: "/bin/tool",
  });
});

Deno.test("terminal initializer supports partial sizes and leaves unsized commands alone", () => {
  assertEquals(initializeTerminal({ cmd: ["tool"] }, undefined, undefined), {
    cmd: ["tool"],
  });
  assertEquals(
    initializeTerminal({ cmd: ["tool", "arg"] }, 12, undefined).cmd.slice(4),
    ["12", "", "tool", "tool", "arg"],
  );
  assertEquals(
    initializeTerminal({ cmd: ["tool"] }, undefined, 34).cmd.slice(4),
    ["", "34", "tool", "tool"],
  );
});
