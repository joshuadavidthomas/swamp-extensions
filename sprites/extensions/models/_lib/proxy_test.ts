// SPDX-License-Identifier: MIT
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Query } from "./core.ts";
import type { Channel, Message } from "./socket.ts";
import { connectExecProxy, ProxyArgs, runProxy } from "./proxy.ts";

import {
  binaryFrame,
  FakeChannel,
  testContext,
  textFrame,
} from "./test_support.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as net from "node:net";
const encoder = new TextEncoder();
const globalArgs = {
  token: "top-secret-token",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
};
const sprite = {
  id: "sprite-id",
  name: "demo sprite",
  organization: "org",
  url: "https://demo.example",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  url_settings: null,
  version: null,
  environment_version: null,
};

function binary(stream: number, bytes: number[] = []): Message {
  return binaryFrame(stream, ...bytes);
}
async function verified<T>(run: () => Promise<T>): Promise<T> {
  const { result } = await withMockedFetch(
    [
      new Response(JSON.stringify(sprite), {
        headers: { "content-type": "application/json" },
      }),
    ],
    run,
  );
  return result;
}

function fakeServer(
  onListen: (options: net.ListenOptions, bound: () => void) => void = (
    _options,
    bound,
  ) => bound(),
  onClose: () => void = () => {},
) {
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (options, callback) => {
    server.listening = true;
    onListen(options, callback);
    return server;
  };
  server.close = (callback) => {
    onClose();
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  return server;
}
Deno.test("exec relay uses fixed argv, split ack, and queues raw stdout", async () => {
  const channel = new FakeChannel([
    textFrame({ type: "session_info", session_id: "session", tty: false }),
    textFrame({ type: "port_opened", port: 5432 }),
    binary(1, [0, 255, 8]),
    binary(2, Array.from(encoder.encode("conn"))),
    textFrame({ type: "debug", message: "starting" }),
    binary(2, Array.from(encoder.encode("ected\n"))),
    textFrame({ type: "port_closed", port: 5432 }),
    binary(1, [7, 6]),
    binary(3, [0]),
  ]);
  let query: Query | undefined;
  const stream = await connectExecProxy(
    testContext(globalArgs, {}),
    "db.internal",
    5432,
    (_ctx, path, value) => {
      assertEquals(path, "/v1/sprites/demo%20sprite/exec");
      query = value;
      return Promise.resolve(channel);
    },
  );
  const argv = query!.cmd as string[];
  assertEquals(argv.slice(0, 4), [
    "/.sprite/bin/python3",
    "-I",
    "-u",
    "-c",
  ]);
  assertStringIncludes(argv[4], "data=os.read(0,65536)");
  assertEquals(argv[4].includes("sys.stdin.buffer.read"), false);
  assertStringIncludes(argv[4], "threading.Timer(float(sys.argv[3])");
  assertEquals(argv.slice(-3, -1), ["db.internal", "5432"]);
  const remainingSeconds = Number(argv.at(-1));
  assertEquals(Number.isFinite(remainingSeconds), true);
  assertEquals(remainingSeconds > 0, true);
  assertEquals(remainingSeconds <= globalArgs.timeoutMs / 1_000, true);
  assertEquals(argv.join(" ").includes(globalArgs.token), false);
  assertEquals(query!.stdin, true);
  assertEquals(query!.tty, false);
  assertEquals(query!.max_run_after_disconnect, "1s");
  const received: number[] = [];
  for await (const chunk of stream) received.push(...chunk);
  assertEquals(received, [0, 255, 8, 7, 6]);
  assertEquals(channel.closed, true);
});

Deno.test("exec relay frames stdin bytes and sends EOF without closing the channel", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const stream = await connectExecProxy(
    testContext(globalArgs, {}),
    "service",
    80,
    () => Promise.resolve(channel),
  );
  await new Promise<void>((resolve, reject) =>
    stream.write(
      new Uint8Array([0, 255, 4]),
      (error) => error ? reject(error) : resolve(),
    )
  );
  await new Promise<void>((resolve, reject) =>
    stream.end((error?: Error | null) => error ? reject(error) : resolve())
  );
  assertEquals(Array.from(channel.sent[0] as Uint8Array), [0, 0, 255, 4]);
  assertEquals(Array.from(channel.sent[1] as Uint8Array), [4]);
  assertEquals(channel.closed, false);
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.destroy();
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("exec relay rejects a connection failure before acknowledgement", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("relay failed\n"))),
  ]);
  await assertRejects(
    () =>
      connectExecProxy(
        testContext(globalArgs),
        "missing",
        9,
        () => Promise.resolve(channel),
      ),
    Error,
    "did not receive",
  );
  assertEquals(channel.sent, [
    JSON.stringify({ type: "signal", signal: "SIGTERM" }),
  ]);
  assertEquals(channel.closed, true);
});

Deno.test("exec relay reports nonzero native binary exit as an error", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    binary(3, [124]),
  ]);
  const stream = await connectExecProxy(
    testContext(globalArgs, {}),
    "service",
    80,
    () => Promise.resolve(channel),
  );
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.resume();
  assertStringIncludes((await failed).message, "code 124");
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("exec relay accepts the native JSON exit code", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    textFrame({ type: "port_opened", port: 1234 }),
    textFrame({ type: "port_closed", port: 1234 }),
    textFrame({ type: "exit", exit_code: 0 }),
  ]);
  const stream = await connectExecProxy(
    testContext(globalArgs, {}),
    "service",
    80,
    () => Promise.resolve(channel),
  );
  const output: number[] = [];
  for await (const chunk of stream) output.push(...chunk);
  assertEquals(output, []);
  assertEquals(channel.closed, true);
});

Deno.test("exec relay treats WebSocket close without exit as an error", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    null,
  ]);
  const stream = await connectExecProxy(
    testContext(globalArgs, {}),
    "service",
    80,
    () => Promise.resolve(channel),
  );
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.resume();
  assertStringIncludes((await failed).message, "without an exit frame");
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("destroy signals the owned remote exec and closes its channel", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const stream = await connectExecProxy(
    testContext(globalArgs, {}),
    "service",
    80,
    () => Promise.resolve(channel),
  );
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.destroy();
  await closed;
  assertEquals(channel.sent, [
    JSON.stringify({ type: "signal", signal: "SIGTERM" }),
  ]);
  assertEquals(channel.closed, true);
});

Deno.test("parent cancellation destroys an established relay", async () => {
  const abort = new AbortController();
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const stream = await connectExecProxy(
    testContext(globalArgs, {
      signal: abort.signal,
    }),
    "service",
    80,
    () => Promise.resolve(channel),
  );
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.resume();
  abort.abort();
  assertStringIncludes((await failed).message, "cancelled");
  await closed;
  assertEquals(channel.closed, true);
});

Deno.test("exec relay enforces its monotonic deadline while control frames stay queued", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
  ]);
  const originalNow = performance.now;
  let now = 0;
  performance.now = () => now;
  const originalRead = channel.read.bind(channel);
  channel.read = () => {
    if (channel.reads === 0) return originalRead();
    channel.reads++;
    now += 10_000;
    return Promise.resolve(textFrame({ type: "debug", message: "queued" }));
  };
  try {
    const stream = await connectExecProxy(
      testContext(globalArgs, {}),
      "service",
      80,
      () => Promise.resolve(channel),
    );
    const failed = new Promise<Error>((resolve) =>
      stream.once("error", resolve)
    );
    stream.resume();
    assertStringIncludes((await failed).message, "timeoutMs");
    assertEquals(channel.reads < 100_000, true);
    assertEquals(channel.closed, true);
  } finally {
    performance.now = originalNow;
  }
});

Deno.test("exec relay stops channel reads when its consumer backpressures", async () => {
  const channel = new FakeChannel([
    binary(2, Array.from(encoder.encode("connected\n"))),
    binary(1, Array(100_000).fill(1)),
    binary(1, Array(100_000).fill(2)),
  ]);
  const stream = await connectExecProxy(
    testContext(globalArgs, {}),
    "service",
    80,
    () => Promise.resolve(channel),
  );
  try {
    stream.read(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(channel.reads, 2);
    assertEquals(stream.readableLength, 100_000);
  } finally {
    stream.destroy();
  }
});

Deno.test("proxy global timeout closes a zero-client listener", () =>
  verified(async () => {
    let closed = false;
    const server = fakeServer((_options, callback) => {
      callback();
    }, () => {
      closed = true;
    });
    await assertRejects(
      () =>
        runProxy(
          testContext({ ...globalArgs, timeoutMs: 50 }, {
            storedResources: { state: { id: sprite.id } },
          }),
          ProxyArgs.parse({
            localPort: 41000,
            host: "db.example.net",
            port: 5432,
            durationMs: 1_000,
          }),
          {
            createServer: (() => server) as unknown as typeof net.createServer,
          },
        ),
      Error,
      "timeoutMs",
    );
    assertEquals(closed, true);
  }));

Deno.test("proxy rejects a handshake still pending when duration cleanup aborts it", () =>
  verified(async () => {
    let rejectRead: ((error: Error) => void) | undefined;
    let channelClosed = false;
    const channel: Channel = {
      read: () =>
        new Promise<Message | null>((_resolve, reject) => {
          rejectRead = reject;
        }),
      send: () => Promise.resolve(),
      close: () => {
        channelClosed = true;
        rejectRead?.(new Error("active channel aborted"));
      },
    };
    const socket = new PassThrough();
    let accept: (socket: net.Socket) => void = () => {};
    let listenerClosed = false;
    const server = fakeServer((_options, callback) => {
      callback();
      accept(socket as unknown as net.Socket);
    }, () => {
      listenerClosed = true;
    });
    await assertRejects(
      () =>
        runProxy(
          testContext(globalArgs, {
            storedResources: { state: { id: sprite.id } },
          }),
          ProxyArgs.parse({
            localPort: 41000,
            host: "db.example.net",
            port: 5432,
            durationMs: 2,
          }),
          {
            connect: () => Promise.resolve(channel),
            createServer: ((_options: unknown, onConnection: typeof accept) => {
              accept = onConnection;
              return server;
            }) as unknown as typeof net.createServer,
          },
        ),
      Error,
      "TCP proxy observation ended.",
    );
    assertEquals(listenerClosed, true);
    assertEquals(channelClosed, true);
    assertEquals(socket.destroyed, true);
  }));

Deno.test("proxy cancels its owned handshake when the local client closes", () =>
  verified(async () => {
    const channel = new FakeChannel([]);
    const socket = new PassThrough();
    let accept: (socket: net.Socket) => void = () => {};
    const server = fakeServer((_options, callback) => {
      callback();
      accept(socket as unknown as net.Socket);
      queueMicrotask(() => socket.destroy());
    });
    const output = await runProxy(
      testContext(globalArgs, {
        storedResources: { state: { id: sprite.id } },
      }),
      ProxyArgs.parse({
        localPort: 41000,
        host: "db.example.net",
        port: 5432,
        durationMs: 2,
      }),
      {
        connect: () => Promise.resolve(channel),
        createServer: ((_options: unknown, onConnection: typeof accept) => {
          accept = onConnection;
          return server;
        }) as unknown as typeof net.createServer,
      },
    );
    assertEquals(output.acceptedConnections, 1);
    assertEquals(output.completedConnections, 1);
    assertEquals(channel.closed, true);
    assertEquals(socket.destroyed, true);
  }));

Deno.test("proxy duration treats active-channel abort of an established tunnel as cleanup", () =>
  verified(async () => {
    let reads = 0;
    let rejectRead: ((error: Error) => void) | undefined;
    let channelClosed = false;
    const channel: Channel = {
      read: () => {
        reads++;
        if (reads === 1) {
          return Promise.resolve(binary(2, [...encoder.encode("connected\n")]));
        }
        return new Promise<Message | null>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
      send: () => Promise.resolve(),
      close: () => {
        channelClosed = true;
        rejectRead?.(new Error("active channel aborted before socket close"));
      },
    };
    const socket = new PassThrough();
    let accept: (socket: net.Socket) => void = () => {};
    const server = fakeServer((_options, callback) => {
      callback();
      accept(socket as unknown as net.Socket);
    });
    const output = await runProxy(
      testContext(globalArgs, {
        storedResources: { state: { id: sprite.id } },
      }),
      ProxyArgs.parse({
        localPort: 41000,
        host: "db.example.net",
        port: 5432,
        durationMs: 2,
      }),
      {
        connect: (ctx) => {
          ctx.signal.addEventListener("abort", () => channel.close(), {
            once: true,
          });
          return Promise.resolve(channel);
        },
        createServer: ((_options: unknown, onConnection: typeof accept) => {
          accept = onConnection;
          return server;
        }) as unknown as typeof net.createServer,
      },
    );
    assertEquals(output.acceptedConnections, 1);
    assertEquals(output.completedConnections, 1);
    assertEquals(channelClosed, true);
    assertEquals(socket.destroyed, true);
  }));

Deno.test("proxy global timeout expires a pending handshake and closes every owner", () =>
  verified(async () => {
    const channel = new FakeChannel([]);
    const socket = new PassThrough();
    let accept: (socket: net.Socket) => void = () => {};
    let listenerClosed = false;
    const server = fakeServer((_options, callback) => {
      callback();
      accept(socket as unknown as net.Socket);
    }, () => {
      listenerClosed = true;
    });
    await assertRejects(
      () =>
        runProxy(
          testContext({ ...globalArgs, timeoutMs: 50 }, {
            storedResources: { state: { id: sprite.id } },
          }),
          ProxyArgs.parse({
            localPort: 41000,
            host: "db.example.net",
            port: 5432,
            durationMs: 1_000,
          }),
          {
            connect: () => Promise.resolve(channel),
            createServer: ((_options: unknown, onConnection: typeof accept) => {
              accept = onConnection;
              return server;
            }) as unknown as typeof net.createServer,
          },
        ),
      Error,
      "timeoutMs",
    );
    assertEquals(listenerClosed, true);
    assertEquals(channel.closed, true);
    assertEquals(socket.destroyed, true);
  }));

Deno.test("proxy gives late connections the remaining deadline and aggregate queue share", () =>
  verified(async () => {
    const socket = new PassThrough();
    const channel = new FakeChannel([
      binary(2, [...encoder.encode("connected\n")]),
    ]);
    let accept: (socket: net.Socket) => void = () => {};
    let connectionTimeoutMs = 0;
    let connectionMaxResponseBytes = 0;
    const server = fakeServer((_options, callback) => {
      callback();
      setTimeout(() => accept(socket as unknown as net.Socket), 10);
    });
    const ctx = testContext({
      ...globalArgs,
      timeoutMs: 200,
      maxResponseBytes: 8 * 1024 * 1024,
    }, { storedResources: { state: { id: sprite.id } } });
    const output = await runProxy(
      ctx,
      ProxyArgs.parse({
        localPort: 41000,
        host: "db.example.net",
        port: 5432,
        durationMs: 30,
        maxConnections: 1_024,
      }),
      {
        connect: (connectionContext) => {
          connectionTimeoutMs = connectionContext.globalArgs.timeoutMs;
          connectionMaxResponseBytes =
            connectionContext.globalArgs.maxResponseBytes;
          return Promise.resolve(channel);
        },
        createServer: ((_options: unknown, onConnection: typeof accept) => {
          accept = onConnection;
          return server;
        }) as unknown as typeof net.createServer,
      },
    );
    assertEquals(output.acceptedConnections, 1);
    assertEquals(connectionMaxResponseBytes, 128 * 1024);
    assertEquals(connectionTimeoutMs > 0, true);
    assertEquals(connectionTimeoutMs < 200, true);
    assertEquals(ctx.globalArgs.maxResponseBytes, 8 * 1024 * 1024);
    assertEquals(channel.closed, true);
    assertEquals(socket.destroyed, true);
  }));

Deno.test("proxy binds only loopback and reports closed listener counters", () =>
  verified(async () => {
    let listenOptions: net.ListenOptions | undefined;
    let closed = false;
    const server = fakeServer((options, callback) => {
      listenOptions = options;
      queueMicrotask(callback);
    }, () => {
      closed = true;
    });
    const output = await runProxy(
      testContext(globalArgs, {
        storedResources: { state: { id: sprite.id } },
      }),
      ProxyArgs.parse({
        localPort: 41000,
        host: "db.example.net",
        port: 5432,
        durationMs: 1,
      }),
      {
        createServer: (() => server) as unknown as typeof net.createServer,
      },
    );
    assertEquals(listenOptions, {
      host: "127.0.0.1",
      port: 41000,
      exclusive: true,
    });
    assertEquals(closed, true);
    assertEquals(output, {
      localAddress: "127.0.0.1",
      localPort: 41000,
      remoteHost: "db.example.net",
      remotePort: 5432,
      acceptedConnections: 0,
      completedConnections: 0,
      rejectedConnections: 0,
      bytesFromClients: 0,
      bytesFromRemote: 0,
      durationMs: 1,
      closed: true,
    });
  }));

for (const finish of ["duration", "cancel", "failure"] as const) {
  Deno.test(`proxy caps connections and closes active tunnels after ${finish}`, () =>
    verified(async () => {
      const controller = new AbortController();
      const channel = new FakeChannel([
        binary(2, [...encoder.encode("connected\n")]),
      ]);
      const sockets = [new PassThrough(), new PassThrough()];
      let connections = 0;
      let connectedPath: string | undefined;
      let accept: (socket: net.Socket) => void;
      const server = fakeServer((_options, callback) => {
        queueMicrotask(() => {
          callback();
          queueMicrotask(() => {
            for (const socket of sockets) {
              accept(socket as unknown as net.Socket);
            }
          });
        });
      });
      const pending = runProxy(
        testContext(globalArgs, {
          signal: controller.signal,
          storedResources: { state: { id: sprite.id } },
        }),
        ProxyArgs.parse({
          localPort: 41000,
          host: "db.example.net",
          port: 5432,
          durationMs: 30,
          maxConnections: 1,
        }),
        {
          connect: (_ctx, path) => {
            connections++;
            connectedPath = path;
            return Promise.resolve(channel);
          },
          createServer: ((_options: unknown, onConnection: typeof accept) => {
            accept = onConnection;
            return server;
          }) as unknown as typeof net.createServer,
        },
      );
      const timer = setTimeout(() => {
        if (finish === "cancel") controller.abort();
        if (finish === "failure") {
          sockets[0].destroy(new Error("simulated client failure"));
        }
      }, 5);
      try {
        if (finish === "duration") {
          const output = await pending;
          assertEquals(output.acceptedConnections, 2);
          assertEquals(output.rejectedConnections, 1);
          assertEquals(output.completedConnections, 1);
        } else {
          await assertRejects(
            () => pending,
            Error,
            finish === "cancel" ? "cancelled" : "connection failed",
          );
        }
        assertEquals(connections, 1);
        assertEquals(connectedPath, "/v1/sprites/demo%20sprite/exec");
        assertEquals(server.listening, false);
        assertEquals(channel.closed, true);
        assertEquals(sockets.every((socket) => socket.destroyed), true);
      } finally {
        clearTimeout(timer);
      }
    }));
}

for (const rejectClose of [false, true]) {
  Deno.test(`proxy waits for deferred tunnel close (reject=${rejectClose})`, () =>
    verified(async () => {
      const closing = Promise.withResolvers<void>();
      const closeStarted = Promise.withResolvers<void>();
      const channel = new FakeChannel(
        [
          binary(2, [...encoder.encode("connected\n")]),
        ],
        () => {
          closeStarted.resolve();
          return closing.promise;
        },
      );
      const socket = new PassThrough();
      let accept: (socket: net.Socket) => void = () => {};
      const server = fakeServer((_options, callback) => {
        callback();
        accept(socket as unknown as net.Socket);
      });
      let settled = false;
      const pending = runProxy(
        testContext(globalArgs, {
          storedResources: { state: { id: sprite.id } },
        }),
        ProxyArgs.parse({
          localPort: 41000,
          host: "db.example.net",
          port: 5432,
          durationMs: 2,
        }),
        {
          connect: () => Promise.resolve(channel),
          createServer: ((_options: unknown, onConnection: typeof accept) => {
            accept = onConnection;
            return server;
          }) as unknown as typeof net.createServer,
        },
      );
      void pending.then(() => {
        settled = true;
      }, () => {
        settled = true;
      });
      try {
        await closeStarted.promise;
        await new Promise((resolve) => setTimeout(resolve, 10));
        assertEquals(settled, false);
        assertEquals(socket.destroyed, true);
        if (rejectClose) {
          closing.reject(new Error("deferred close failed"));
          await assertRejects(() => pending, Error, "cleanup failed");
        } else {
          closing.resolve();
          const output = await pending;
          assertEquals(output.acceptedConnections, 1);
          assertEquals(output.completedConnections, 1);
          assertEquals(output.closed, true);
        }
      } finally {
        closing.resolve();
        await pending.catch(() => {});
      }
    }));
}

Deno.test("proxy verifies identity once before accepting multiple connections", async () => {
  const channels = [
    new FakeChannel([binary(2, [...encoder.encode("connected\n")])]),
    new FakeChannel([binary(2, [...encoder.encode("connected\n")])]),
  ];
  const sockets = [new PassThrough(), new PassThrough()];
  let connections = 0;
  let accept: (socket: net.Socket) => void;
  const server = fakeServer((_options, bound) => {
    bound();
    for (const socket of sockets) accept(socket as unknown as net.Socket);
  });
  const { calls, result } = await withMockedFetch([
    new Response(JSON.stringify(sprite), {
      headers: { "content-type": "application/json" },
    }),
  ], () =>
    runProxy(
      testContext(globalArgs, {
        storedResources: { state: { id: sprite.id } },
      }),
      ProxyArgs.parse({
        localPort: 41000,
        host: "db.internal",
        port: 5432,
        durationMs: 10,
      }),
      {
        connect: () => Promise.resolve(channels[connections++]),
        createServer: ((_options: unknown, onConnection: typeof accept) => {
          accept = onConnection;
          return server;
        }) as unknown as typeof net.createServer,
      },
    ));
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://api.sprites.dev/v1/sprites/demo%20sprite",
  );
  assertEquals(connections, 2);
  assertEquals(result.completedConnections, 2);
  assertEquals(channels.every((channel) => channel.closed), true);
});
