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
import { type Message } from "./socket.ts";
import { SpriteArgsSchema, type SpriteContext } from "./sprite.ts";
import { binaryFrame, FakeChannel, textFrame } from "./test_support.ts";
import { TERMINAL_PROGRAM, TERMINAL_PYTHON } from "./exec.ts";

const encoder = new TextEncoder();
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
  let connections = 0;
  let path = "";
  const channel = new FakeChannel([...messages, null]);
  const sent = channel.sent;
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
    closed: () => Number(channel.closed),
    connections: () => connections,
    path: () => path,
  };
}

Deno.test("control exec reuses one socket and stores aggregate streams with per-operation ranges", async () => {
  const test = setup([
    textFrame({
      type: "debug",
      message: "provider diagnostics are not command output",
    }),
    textFrame({ type: "session_info", tty: false, session_id: "one" }),
    textFrame({ type: "port_opened", port: 3000 }),
    textFrame({ type: "port_closed", port: 3000 }),
    binaryFrame(1, 65, 0),
    binaryFrame(2, 69),
    binaryFrame(3, 7),
    textFrame({ type: "exit", exit_code: 7 }),
    {
      binary: false,
      bytes: encoder.encode(
        `control:${
          JSON.stringify({
            type: "op.complete",
            op: "exec",
            args: { exitCode: 7 },
          })
        }`,
      ),
    },
    binaryFrame(1, 66, 67),
    textFrame({ type: "exit", exit_code: 0 }),
    {
      binary: false,
      bytes: encoder.encode(
        `control:${JSON.stringify({ type: "op.complete", args: {} })}`,
      ),
    },
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
    binaryFrame(0, 1, 2, 255),
    {
      binary: false,
      bytes: encoder.encode(
        `control:${
          JSON.stringify({ type: "op.complete", args: { exitCode: 12 } })
        }`,
      ),
    },
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

Deno.test("control exec rejects unsupported input shapes before connecting", () => {
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
      }, {
        cmd: ["cat"],
        actions: [{ type: "eof", atMs: 0 }, { type: "eof", atMs: 1 }],
      }],
    }, {
      cmd: ["cat"],
      actions: [{ type: "eof", atMs: 0 }, { type: "eof", atMs: 1 }],
    }]
  ) {
    assertThrows(() => ControlExecArgs.parse({ operations: [operation] }));
  }
});

Deno.test("control exec rejects protocol errors, unsupported frames, and truncated operations", async () => {
  const cases: Array<{ frames: Message[]; includes: string }> = [{
    frames: [textFrame({ "type": "notice" })],
    includes: "unsupported text",
  }, {
    frames: [{
      binary: false,
      bytes: encoder.encode(`control:${JSON.stringify({ type: "other" })}`),
    }],
    includes: "unsupported control",
  }, {
    frames: [
      {
        binary: false,
        bytes: encoder.encode(
          `control:${
            JSON.stringify({
              type: "op.complete",
              op: "proxy",
              args: { exitCode: 0 },
            })
          }`,
        ),
      },
    ],
    includes: "unsupported control",
  }, {
    frames: [textFrame({ "type": "session_info", "tty": true })],
    includes: "mismatched TTY",
  }, {
    frames: [binaryFrame(9, 1)],
    includes: "invalid frame",
  }, {
    frames: [binaryFrame(3, 0), binaryFrame(3, 0)],
    includes: "duplicate exit",
  }, {
    frames: [binaryFrame(3, 0), textFrame({ "type": "exit", "exit_code": 1 })],
    includes: "conflicting exit",
  }, {
    frames: [
      binaryFrame(3, 0),
      {
        binary: false,
        bytes: encoder.encode(
          `control:${
            JSON.stringify({ type: "op.complete", args: { exitCode: 1 } })
          }`,
        ),
      },
    ],
    includes: "conflicting exit",
  }, {
    frames: [{
      binary: false,
      bytes: encoder.encode(
        `control:${JSON.stringify({ type: "op.complete", args: {} })}`,
      ),
    }],
    includes: "without an exit status",
  }, {
    frames: [binaryFrame(3, 0)],
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
  const test = setup([textFrame({ type: label })]);
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
    binaryFrame(1, 65),
    {
      binary: false,
      bytes: encoder.encode(`control:${
        JSON.stringify({
          type: "op.error",
          args: { error: "provider-secret test-token" },
        })
      }`),
    },
  ]);
  const error = await assertRejects(() =>
    executeControl(
      test.ctx,
      ControlExecArgs.parse({ operations: [{ cmd: ["false"] }] }),
      test.connect,
    ), Error);
  assertFalse(error.message.includes("provider-secret"));
  assertFalse(error.message.includes("test-token"));
  assertEquals(test.getWrittenFiles(), []);
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("response accounting spans binary and control frames across all operations", async () => {
  const frames = [
    binaryFrame(1, 1),
    binaryFrame(3, 0),
    {
      binary: false,
      bytes: encoder.encode(
        `control:${JSON.stringify({ type: "op.complete" })}`,
      ),
    },
    binaryFrame(3, 0),
    {
      binary: false,
      bytes: encoder.encode(
        `control:${JSON.stringify({ type: "op.complete" })}`,
      ),
    },
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
    binaryFrame(3, 23),
    {
      binary: false,
      bytes: encoder.encode(
        `control:${
          JSON.stringify({ type: "op.complete", args: { exitCode: 23 } })
        }`,
      ),
    },
    binaryFrame(3, 0),
    {
      binary: false,
      bytes: encoder.encode(
        `control:${
          JSON.stringify({ type: "op.complete", args: { exitCode: 0 } })
        }`,
      ),
    },
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
      reads === 1 ? textFrame({ type: "debug" }) : {
        binary: false,
        bytes: encoder.encode(
          `control:${
            JSON.stringify({ type: "op.complete", args: { exitCode: 0 } })
          }`,
        ),
      },
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
    return Promise.resolve(textFrame({ type: "debug" }));
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
