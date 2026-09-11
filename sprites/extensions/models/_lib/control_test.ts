// SPDX-License-Identifier: MIT
import { method } from "./core.ts";
import { z } from "zod";
import { type ConnectChannel } from "./socket.ts";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import {
  ControlExecArgs,
  controlResources,
  executeControl,
  saveControlExecution,
} from "./control.ts";
import { type Channel, type Message } from "./socket.ts";
import { SpriteArgsSchema, type SpriteContext } from "./sprite-api.ts";
import { TERMINAL_PROGRAM, TERMINAL_PYTHON } from "./terminal.ts";

const encoder = new TextEncoder();
const binary = (...bytes: number[]): Message => ({
  binary: true,
  bytes: new Uint8Array(bytes),
});
const text = (value: string): Message => ({
  binary: false,
  bytes: encoder.encode(value),
});
const control = (value: unknown): Message =>
  text(`control:${JSON.stringify(value)}`);

function setup(
  messages: Message[],
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<SpriteContext["globalArgs"]> = {},
) {
  const globalArgs = SpriteArgsSchema.parse({
    token: "test-token",
    name: "worker name",
    ...overrides,
  });
  const test = createModelTestContext({ globalArgs });
  const ctx: SpriteContext = {
    ...test.context,
    globalArgs,
    signal,
    deleteResource: () => Promise.resolve(),
  };
  const sent: (string | Uint8Array)[] = [];
  let closed = 0;
  let connections = 0;
  let path = "";
  let concurrentReads = 0;
  let maximumReads = 0;
  const channel: Channel = {
    read: () => {
      concurrentReads++;
      maximumReads = Math.max(maximumReads, concurrentReads);
      const message = messages.shift() ?? null;
      concurrentReads--;
      return Promise.resolve(message);
    },
    send: (data) => {
      sent.push(data);
      return Promise.resolve();
    },
    close: () => {
      closed++;
    },
    closeCode: () => 1000,
  };
  const connect: ConnectChannel = (_ctx, value) => {
    connections++;
    path = value;
    return Promise.resolve(channel);
  };
  return {
    ...test,
    ctx,
    channel,
    connect,
    sent,
    closed: () => closed,
    connections: () => connections,
    path: () => path,
    maximumReads: () => maximumReads,
  };
}

Deno.test("control exec reuses one socket and stores aggregate streams with per-operation ranges", async () => {
  const test = setup([
    text(
      JSON.stringify({
        type: "debug",
        message: "provider diagnostics are not command output",
      }),
    ),
    text(
      JSON.stringify({ type: "session_info", tty: false, session_id: "one" }),
    ),
    text(JSON.stringify({ type: "port_opened", port: 3000 })),
    text(JSON.stringify({ type: "port_closed", port: 3000 })),
    binary(1, 65, 0),
    binary(2, 69),
    binary(3, 7),
    text(JSON.stringify({ type: "exit", exit_code: 7 })),
    control({ type: "op.complete", op: "exec", args: { exitCode: 7 } }),
    binary(1, 66, 67),
    text(JSON.stringify({ type: "exit", exit_code: 0 })),
    control({ type: "op.complete", args: {} }),
  ]);
  const args = ControlExecArgs.parse({
    operations: [{
      cmd: ["sh", "-c", "printf test"],
      env: { FOO: "one two" },
      dir: "/work dir",
      input: { kind: "base64", base64: "AP8=" },
      failOnNonZero: false,
    }, {
      cmd: ["true"],
    }],
  });
  const result = await executeControl(test.ctx, args, test.connect);

  assertEquals(test.connections(), 1);
  assertEquals(test.path(), "/v1/sprites/worker%20name/control");
  assertEquals(test.maximumReads(), 1);
  assertEquals(test.sent, [
    'control:{"type":"op.start","op":"exec","args":{"cmd":["sh","-c","printf test"],"env":["FOO=one two"],"stdin":"true","dir":"/work dir"}}',
    new Uint8Array([0, 0, 255]),
    new Uint8Array([4]),
    'control:{"type":"op.start","op":"exec","args":{"cmd":["true"],"env":[],"stdin":"false"}}',
  ]);
  assertEquals(result.stdout, new Uint8Array([65, 0, 66, 67]));
  assertEquals(result.stderr, new Uint8Array([69]));
  assertEquals(result.operations, [{
    operation: 1,
    exitCode: 7,
    tty: false,
    stdoutOffset: 0,
    stdoutLength: 2,
    stderrOffset: 0,
    stderrLength: 1,
  }, {
    operation: 2,
    exitCode: 0,
    tty: false,
    stdoutOffset: 2,
    stdoutLength: 2,
    stderrOffset: 1,
    stderrLength: 0,
  }]);
  assertEquals(test.closed(), 1);

  const saved = await method(
    "Save execution",
    z.object({}),
    "controlExecution",
    controlResources.controlExecution.schema,
    () => saveControlExecution(test.ctx, result),
  ).execute({}, test.ctx);
  assertEquals(saved.dataHandles.map((handle) => handle.name), [
    "controlStdout",
    "controlStderr",
    "controlExecution",
  ]);
  assertEquals(test.getWrittenFiles().map((file) => file.name), [
    "controlStdout",
    "controlStderr",
  ]);
  assertEquals(
    test.getWrittenResources()[0].data.operations,
    result.operations,
  );
});

Deno.test("TTY operations send raw stdin plus text JSON resize and signal controls", async () => {
  const test = setup([]);
  const queued = [
    binary(0, 1, 2, 255),
    control({ type: "op.complete", args: { exitCode: 12 } }),
  ];
  let release: ((message: Message) => void) | undefined;
  let reads = 0;
  test.channel.read = () => {
    reads++;
    if (reads === 1) {
      return new Promise<Message>((resolve) => {
        release = resolve;
      });
    }
    return Promise.resolve(queued.shift() ?? null);
  };
  test.channel.send = (data) => {
    test.sent.push(data);
    if (test.sent.length === 4) release?.(queued.shift()!);
    return Promise.resolve();
  };

  const result = await executeControl(
    test.ctx,
    ControlExecArgs.parse({
      operations: [{
        cmd: ["sh"],
        tty: true,
        rows: 24,
        cols: 80,
        failOnNonZero: false,
        actions: [{
          type: "stdin",
          atMs: 0,
          input: { kind: "base64", base64: "AP8=" },
        }, {
          type: "resize",
          atMs: 0,
          rows: 40,
          cols: 120,
        }, {
          type: "signal",
          atMs: 0,
          signal: "SIGTERM",
        }],
      }],
    }),
    test.connect,
  );

  assertEquals(test.sent, [
    `control:${
      JSON.stringify({
        type: "op.start",
        op: "exec",
        args: {
          cmd: [
            TERMINAL_PYTHON,
            "-I",
            "-c",
            TERMINAL_PROGRAM,
            "24",
            "80",
            "sh",
            "sh",
          ],
          env: [],
          stdin: "true",
          tty: "true",
        },
      })
    }`,
    new Uint8Array([0, 255]),
    '{"type":"resize","cols":120,"rows":40}',
    '{"type":"signal","signal":"SIGTERM"}',
  ]);
  assertEquals(result.stdout, new Uint8Array([0, 1, 2, 255]));
  assertEquals(result.stderr, new Uint8Array());
  assertEquals(result.operations[0].exitCode, 12);
});

Deno.test("control exec rejects unsupported input shapes before connecting", async () => {
  assertThrows(() =>
    ControlExecArgs.parse({
      operations: [{ cmd: ["true"], detachable: true }],
    })
  );
  assertThrows(() => ControlExecArgs.parse({ operations: [] }));
  assertThrows(() =>
    ControlExecArgs.parse({
      operations: [{ cmd: ["true"], tty: true, rows: 65_536 }],
    })
  );
  assertThrows(() =>
    ControlExecArgs.parse({
      operations: [{
        cmd: ["true"],
        tty: true,
        actions: [{ type: "resize", atMs: 0, rows: 1, cols: 65_536 }],
      }],
    })
  );
  assertThrows(() =>
    ControlExecArgs.parse({
      operations: Array.from({ length: 101 }, () => ({ cmd: ["true"] })),
    })
  );

  for (
    const operation of [{ cmd: ["true"], rows: 1 }, {
      cmd: ["true"],
      actions: [{ type: "resize", atMs: 0, rows: 1, cols: 1 }],
    }, {
      cmd: ["sh"],
      tty: true,
      actions: [{ type: "eof", atMs: 0 }],
    }, {
      cmd: ["cat"],
      actions: [{ type: "eof", atMs: 0 }, {
        type: "stdin",
        atMs: 1,
        input: { kind: "text", text: "late" },
      }],
    }]
  ) {
    const test = setup([]);
    await assertRejects(
      () =>
        executeControl(
          test.ctx,
          ControlExecArgs.parse({ operations: [operation] }),
          test.connect,
        ),
    );
    assertEquals(test.connections(), 0);
  }
});

Deno.test("control exec rejects protocol errors, unsupported frames, and truncated operations", async () => {
  const cases: Array<{ frames: Message[]; includes: string }> = [{
    frames: [text('{"type":"notice"}')],
    includes: "unsupported text",
  }, {
    frames: [control({ type: "other" })],
    includes: "unsupported control",
  }, {
    frames: [
      control({ type: "op.complete", op: "proxy", args: { exitCode: 0 } }),
    ],
    includes: "unsupported control",
  }, {
    frames: [text('{"type":"session_info","tty":true}')],
    includes: "mismatched TTY",
  }, {
    frames: [binary(9, 1)],
    includes: "invalid stream",
  }, {
    frames: [binary(3, 0), binary(3, 0)],
    includes: "duplicate exit",
  }, {
    frames: [binary(3, 0), text('{"type":"exit","exit_code":1}')],
    includes: "conflicting exit",
  }, {
    frames: [
      binary(3, 0),
      control({ type: "op.complete", args: { exitCode: 1 } }),
    ],
    includes: "conflicting exit",
  }, {
    frames: [control({ type: "op.complete", args: {} })],
    includes: "without an exit status",
  }, {
    frames: [binary(3, 0)],
    includes: "closed before op.complete",
  }];
  for (const { frames, includes } of cases) {
    const test = setup(frames);
    await assertRejects(
      () =>
        executeControl(
          test.ctx,
          ControlExecArgs.parse({ operations: [{ cmd: ["true"] }] }),
          test.connect,
        ),
      Error,
      includes,
    );
    assertEquals(test.connections(), 1);
    assertEquals(test.closed(), 1);
    assertEquals(test.getWrittenFiles(), []);
    assertEquals(test.getWrittenResources(), []);
  }
});

Deno.test("unsupported control labels never expose embedded operation secrets", async () => {
  const secret = "embeddedsecret";
  const label = `auth_${secret}_failed`;
  const test = setup([text(JSON.stringify({ type: label }))]);
  const error = await assertRejects(
    () =>
      executeControl(
        test.ctx,
        ControlExecArgs.parse({
          operations: [{
            cmd: ["false"],
            env: { PASSWORD: secret },
          }],
        }),
        test.connect,
      ),
    Error,
    "unsupported text frame",
  );
  assertFalse(error.message.includes(secret));
  assertFalse(error.message.includes(label));
});

Deno.test("op.error fails without exposing provider text or saving partial output", async () => {
  const test = setup([
    binary(1, 65),
    control({
      type: "op.error",
      args: { error: "provider-secret test-token" },
    }),
  ]);
  let error: Error | undefined;
  try {
    await executeControl(
      test.ctx,
      ControlExecArgs.parse({ operations: [{ cmd: ["false"] }] }),
      test.connect,
    );
  } catch (value) {
    error = value as Error;
  }
  assert(error);
  assertFalse(error.message.includes("provider-secret"));
  assertFalse(error.message.includes("test-token"));
  assertEquals(test.getWrittenFiles(), []);
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("response accounting spans binary and control frames across all operations", async () => {
  const frames = [
    binary(1, 1),
    binary(3, 0),
    control({ type: "op.complete" }),
    binary(3, 0),
    control({ type: "op.complete" }),
  ];
  const total = frames.reduce((sum, frame) => sum + frame.bytes.length, 0);
  const test = setup(frames);
  test.ctx.globalArgs.maxResponseBytes = total - 1;
  await assertRejects(
    () =>
      executeControl(
        test.ctx,
        ControlExecArgs.parse({
          operations: [{ cmd: ["one"] }, { cmd: ["two"] }],
        }),
        test.connect,
      ),
    Error,
    "maxResponseBytes",
  );
  assertEquals(test.connections(), 1);
  assertEquals(test.closed(), 1);
});

Deno.test("a nonzero operation stops the sequence without retry or persisted batch output", async () => {
  const test = setup([
    binary(3, 23),
    control({ type: "op.complete", args: { exitCode: 23 } }),
    binary(3, 0),
    control({ type: "op.complete", args: { exitCode: 0 } }),
  ]);
  await assertRejects(
    () =>
      executeControl(
        test.ctx,
        ControlExecArgs.parse({
          operations: [{ cmd: ["false"] }, { cmd: ["never"] }],
        }),
        test.connect,
      ),
    Error,
    "operation 1 exited with code 23",
  );
  assertEquals(test.connections(), 1);
  assertEquals(test.sent.length, 1);
  assertEquals(test.getWrittenFiles(), []);
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("due actions run before already-queued control messages", async () => {
  const test = setup([]);
  let reads = 0;
  test.channel.read = () => {
    reads++;
    return Promise.resolve(
      reads === 1
        ? text(JSON.stringify({ type: "debug" }))
        : control({ type: "op.complete", args: { exitCode: 0 } }),
    );
  };
  await executeControl(
    test.ctx,
    ControlExecArgs.parse({
      operations: [{
        cmd: ["sleep", "1"],
        actions: [{ type: "signal", atMs: 0, signal: "SIGTERM" }],
      }],
    }),
    test.connect,
  );
  assertEquals(test.sent, [
    'control:{"type":"op.start","op":"exec","args":{"cmd":["sleep","1"],"env":[],"stdin":"false"}}',
    '{"type":"signal","signal":"SIGTERM"}',
  ]);
  assertEquals(reads, 2);
});

Deno.test("control deadline stops an unbounded queue and never runs a huge action early", async () => {
  const test = setup([], new AbortController().signal, {
    timeoutMs: 1,
    maxResponseBytes: 1_073_741_824,
  });
  let reads = 0;
  test.channel.read = () => {
    reads++;
    return Promise.resolve(text(JSON.stringify({ type: "debug" })));
  };
  await assertRejects(
    () =>
      executeControl(
        test.ctx,
        ControlExecArgs.parse({
          operations: [{
            cmd: ["sleep", "1"],
            actions: [{
              type: "signal",
              atMs: 2_147_483_647,
              signal: "SIGKILL",
            }],
          }],
        }),
        test.connect,
      ),
    Error,
    "timeoutMs",
  );
  assert(reads < 100_000);
  assertEquals(test.sent.length, 1);
  assertEquals(test.closed() >= 1, true);
});

Deno.test("parent cancellation closes the owned socket and prevents pending actions", async () => {
  const parent = new AbortController();
  const test = setup([], parent.signal);
  test.channel.read = () => new Promise(() => {});
  test.channel.send = (data) => {
    test.sent.push(data);
    if (typeof data === "string") queueMicrotask(() => parent.abort());
    return Promise.resolve();
  };
  await assertRejects(
    () =>
      executeControl(
        test.ctx,
        ControlExecArgs.parse({
          operations: [{
            cmd: ["sleep", "10"],
            actions: [{
              type: "signal",
              atMs: 60_000,
              signal: "SIGKILL",
            }],
          }],
        }),
        test.connect,
      ),
  );
  assertEquals(test.sent.length, 1);
  assert(test.closed() >= 1);
});
