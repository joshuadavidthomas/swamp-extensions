// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import type * as net from "node:net";
import type { Channel, Message } from "./socket.ts";
import { SpriteArgsSchema, type SpriteContext } from "./sprite-api.ts";
import {
  connectProxy,
  observeWatch,
  runProxy,
  streamingMethods,
  streamingResources,
} from "./watch-proxy.ts";

const encoder = new TextEncoder();
const globalArgs = {
  token: "test",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo sprite",
};
function context(
  signal = new AbortController().signal,
  overrides: Partial<SpriteContext["globalArgs"]> = {},
): SpriteContext {
  const args = { ...globalArgs, ...overrides };
  const { context } = createModelTestContext({ globalArgs: args });
  return {
    ...context,
    globalArgs: args,
    signal,
    deleteResource: () => Promise.resolve(),
  };
}
function text(value: unknown): Message {
  return { binary: false, bytes: encoder.encode(JSON.stringify(value)) };
}

class FakeChannel implements Channel {
  sent: Array<string | Uint8Array> = [];
  closed = false;
  #messages: Array<Message | null>;
  #waiters: Array<(value: Message | null) => void> = [];
  #closing: Promise<void> | undefined;
  constructor(
    messages: Array<Message | null>,
    private readonly code?: number,
  ) {
    this.#messages = [...messages];
  }
  read(): Promise<Message | null> {
    if (this.#messages.length) {
      return Promise.resolve(this.#messages.shift() ?? null);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  send(data: string | Uint8Array): Promise<void> {
    this.sent.push(data);
    return Promise.resolve();
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.closed = true;
      for (const resolve of this.#waiters.splice(0)) resolve(null);
      this.#closing = Promise.resolve();
    }
    return this.#closing;
  }
  closeCode(): number | undefined {
    return this.code;
  }
}

Deno.test("watch reports bounded provider errors with the bearer token removed", async () => {
  const channel = new FakeChannel([
    text({
      type: "error",
      message: `failed for ${globalArgs.token}\n\u2028\u202e${
        "x".repeat(1000)
      }`,
    }),
  ]);
  const error = await assertRejects(
    () =>
      observeWatch(
        context(),
        { paths: ["."], durationMs: 100 },
        () => Promise.resolve(channel),
      ),
    Error,
  );
  assertStringIncludes(error.message, "[redacted]");
  assertEquals(error.message.includes(globalArgs.token), false);
  assertEquals(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(error.message), false);
  assertEquals(error.message.length < 600, true);
  assertEquals(channel.closed, true);
});

Deno.test("watch bounds cumulative received bytes even when its queue drains", async () => {
  const channel = new FakeChannel([
    text({ type: "subscribed" }),
    text({ type: "event", path: "first-long-path", event: "write" }),
    text({ type: "event", path: "second-long-path", event: "write" }),
  ]);
  const ctx = {
    ...context(),
    globalArgs: { ...globalArgs, maxResponseBytes: 90 },
  };
  await assertRejects(
    () =>
      observeWatch(
        ctx,
        { paths: ["."], durationMs: 1_000, maxEvents: 10 },
        () => Promise.resolve(channel),
      ),
    Error,
    "maxResponseBytes",
  );
  assertEquals(channel.closed, true);
});

Deno.test("watch monotonic deadline stops an unbounded resolved queue", async () => {
  const channel = new FakeChannel([]);
  let reads = 0;
  channel.read = () => {
    reads++;
    return Promise.resolve(
      reads === 1
        ? text({ type: "subscribed" })
        : text({ type: "event", path: "queued", event: "write" }),
    );
  };
  const output = await observeWatch(
    context(undefined, { maxResponseBytes: 1_073_741_824 }),
    { paths: ["."], durationMs: 1, maxEvents: 100_000 },
    () => Promise.resolve(channel),
  );
  assertEquals(output.events.length < 100_000, true);
  assertEquals(reads < 100_001, true);
  assertEquals(channel.closed, true);
});

Deno.test("watch sends the exact subscription and preserves typed events up to its cap", async () => {
  const channel = new FakeChannel([
    text({ type: "subscribed", paths: ["src"] }),
    text({
      type: "event",
      path: "src/a.ts",
      event: "write",
      timestamp: "now",
      size: 4,
      isDir: false,
    }),
  ]);
  const output = await observeWatch(context(), {
    paths: ["src"],
    recursive: true,
    workingDir: "/app",
    durationMs: 1_000,
    maxEvents: 1,
  }, (_ctx, path) => {
    assertEquals(path, "/v1/sprites/demo%20sprite/fs/watch");
    return Promise.resolve(channel);
  });
  assertEquals(channel.sent, [
    JSON.stringify({
      type: "subscribe",
      paths: ["src"],
      recursive: true,
      workingDir: "/app",
    }),
  ]);
  assertEquals(output, {
    events: [{
      type: "event",
      path: "src/a.ts",
      event: "write",
      timestamp: "now",
      size: 4,
      isDir: false,
    }],
    truncated: true,
  });
  assertEquals(channel.closed, true);
});

Deno.test("watch requires acknowledgement and closes on protocol failure", async () => {
  const channel = new FakeChannel([
    text({ type: "event", path: "a", event: "create" }),
  ]);
  const error = await assertRejects(
    () =>
      observeWatch(
        context(),
        { paths: ["."], durationMs: 10 },
        () => Promise.resolve(channel),
      ),
    Error,
  );
  assertStringIncludes(error.message, "did not acknowledge");
  assertEquals(channel.closed, true);
});

Deno.test("watch cancellation fails and closes a pending read", async () => {
  const controller = new AbortController();
  const channel = new FakeChannel([]);
  const pending = observeWatch(context(controller.signal), {
    paths: ["."],
    durationMs: 1_000,
  }, () => Promise.resolve(channel));
  controller.abort(new Error("parent stopped"));
  await assertRejects(() => pending, Error, "parent stopped");
  assertEquals(channel.closed, true);
});

Deno.test("connectProxy requires connected status and carries raw bytes", async () => {
  const channel = new FakeChannel([
    text({ status: "connected" }),
    { binary: true, bytes: new Uint8Array([0, 255, 7]) },
    null,
  ]);
  const stream = await connectProxy(
    context(),
    "db.example.net",
    5432,
    (_ctx, path) => {
      assertEquals(path, "/v1/sprites/demo%20sprite/proxy");
      return Promise.resolve(channel);
    },
  );
  await new Promise<void>((resolve, reject) =>
    stream.write(
      new Uint8Array([9, 8]),
      (error) => error ? reject(error) : resolve(),
    )
  );
  const received: number[] = [];
  for await (const chunk of stream) received.push(...chunk);
  assertEquals(JSON.parse(channel.sent[0] as string), {
    host: "db.example.net",
    port: 5432,
  });
  assertEquals(Array.from(channel.sent[1] as Uint8Array), [9, 8]);
  assertEquals(received, [0, 255, 7]);
  assertEquals(channel.closed, true);
});

Deno.test("connectProxy sends the native control proxy start frame", async () => {
  const channel = new FakeChannel([
    text({ status: "connected" }),
    { binary: true, bytes: new Uint8Array([1, 2, 3]) },
    {
      binary: false,
      bytes: encoder.encode('control:{"type":"op.complete","op":"proxy"}'),
    },
    { binary: true, bytes: new Uint8Array([99]) },
  ]);
  const stream = await connectProxy(
    context(),
    "service.internal",
    8080,
    (_ctx, path) => {
      assertEquals(path, "/v1/sprites/demo%20sprite/control");
      return Promise.resolve(channel);
    },
    "control",
  );
  const received: number[] = [];
  for await (const chunk of stream) received.push(...chunk);
  assertEquals(
    channel.sent[0],
    `control:${
      JSON.stringify({
        type: "op.start",
        op: "proxy",
        args: { host: "service.internal", port: "8080" },
      })
    }`,
  );
  assertEquals(received, [1, 2, 3]);
  assertEquals(channel.closed, true);
});

Deno.test("proxy ignores empty binary frames without treating them as EOF", async () => {
  const channel = new FakeChannel([
    text({ status: "connected" }),
    { binary: true, bytes: new Uint8Array() },
    { binary: true, bytes: new Uint8Array([4, 5, 6]) },
    null,
  ], 1000);
  const stream = await connectProxy(
    context(),
    "service.internal",
    8080,
    () => Promise.resolve(channel),
  );
  const received: number[] = [];
  for await (const chunk of stream) received.push(...chunk);
  assertEquals(received, [4, 5, 6]);
});

Deno.test("control completion exposes EOF before WebSocket close finishes", async () => {
  let releaseClose: () => void = () => {};
  let closeStarted = false;
  const channel = new FakeChannel([
    text({ status: "connected" }),
    {
      binary: false,
      bytes: encoder.encode('control:{"type":"op.complete","op":"proxy"}'),
    },
  ]);
  const closing = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  channel.close = () => {
    closeStarted = true;
    return closing;
  };
  const stream = await connectProxy(
    context(),
    "service.internal",
    8080,
    () => Promise.resolve(channel),
    "control",
  );
  const ended = new Promise<void>((resolve) => stream.once("end", resolve));
  stream.resume();
  await ended;
  assertEquals(closeStarted, true);
  releaseClose();
  await new Promise<void>((resolve) => stream.once("close", resolve));
});

Deno.test("proxy forwards queued data to a flowing consumer then rejects abnormal close", async () => {
  const channel = new FakeChannel([
    text({ status: "connected" }),
    { binary: true, bytes: new Uint8Array([7, 8, 9]) },
    null,
  ], 1006);
  const stream = await connectProxy(
    context(),
    "service.internal",
    8080,
    () => Promise.resolve(channel),
  );
  const received: number[] = [];
  const failed = new Promise<Error>((resolve) => stream.once("error", resolve));
  stream.on("data", (chunk) => received.push(...chunk));
  const error = await failed;
  assertEquals(
    error.message,
    "Sprite TCP proxy WebSocket closed abnormally with code 1006.",
  );
  assertEquals(received, [7, 8, 9]);
  assertEquals(channel.closed, true);
});

Deno.test("control proxy closes a bad handshake without retrying", async () => {
  const channel = new FakeChannel([text({ status: "waiting" })]);
  let attempts = 0;
  await assertRejects(
    () =>
      connectProxy(
        context(),
        "service.internal",
        8080,
        (_ctx, path) => {
          attempts += 1;
          assertEquals(path, "/v1/sprites/demo%20sprite/control");
          return Promise.resolve(channel);
        },
        "control",
      ),
    Error,
    "did not report connected status",
  );
  assertEquals(attempts, 1);
  assertEquals(channel.closed, true);
});

Deno.test("proxy handshake diagnostics redact request values and bound provider text", async () => {
  const channel = new FakeChannel([{
    binary: false,
    bytes: encoder.encode(
      `control:${
        JSON.stringify({
          type: "op.error",
          args: { error: `test service.internal\u202e\n${"x".repeat(1000)}` },
        })
      }`,
    ),
  }]);
  const error = await assertRejects(
    () =>
      connectProxy(
        context(),
        "service.internal",
        8080,
        () => Promise.resolve(channel),
        "control",
      ),
    Error,
    "did not report connected status",
  );
  assertEquals(error.message.includes("test"), false);
  assertEquals(error.message.includes("service.internal"), false);
  assertEquals(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(error.message), false);
  assertEquals(error.message.length < 580, true);
  assertEquals(channel.closed, true);
});

Deno.test("proxy global timeout closes a zero-client listener", async () => {
  let closed = false;
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (_options, callback) => {
    server.listening = true;
    callback();
    return server;
  };
  server.close = (callback) => {
    closed = true;
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  await assertRejects(
    () =>
      runProxy(
        context(undefined, { timeoutMs: 2 }),
        {
          localPort: 41000,
          host: "db.example.net",
          port: 5432,
          durationMs: 1_000,
        },
        { createServer: (() => server) as unknown as typeof net.createServer },
      ),
    Error,
    "timeoutMs",
  );
  assertEquals(closed, true);
});

Deno.test("proxy rejects a handshake still pending when duration cleanup aborts it", async () => {
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
    closeCode: () => undefined,
  };
  const socket = new PassThrough();
  let accept: (socket: net.Socket) => void = () => {};
  let listenerClosed = false;
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (_options, callback) => {
    server.listening = true;
    callback();
    accept(socket as unknown as net.Socket);
    return server;
  };
  server.close = (callback) => {
    listenerClosed = true;
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  await assertRejects(
    () =>
      runProxy(context(), {
        localPort: 41000,
        host: "db.example.net",
        port: 5432,
        transport: "proxy",
        durationMs: 2,
      }, {
        connect: () => Promise.resolve(channel),
        createServer: ((_options: unknown, onConnection: typeof accept) => {
          accept = onConnection;
          return server;
        }) as unknown as typeof net.createServer,
      }),
    Error,
    "connection failed",
  );
  assertEquals(listenerClosed, true);
  assertEquals(channelClosed, true);
  assertEquals(socket.destroyed, true);
});

Deno.test("proxy cancels its owned handshake when the local client closes", async () => {
  const channel = new FakeChannel([]);
  const socket = new PassThrough();
  let accept: (socket: net.Socket) => void = () => {};
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (_options, callback) => {
    server.listening = true;
    callback();
    accept(socket as unknown as net.Socket);
    queueMicrotask(() => socket.destroy());
    return server;
  };
  server.close = (callback) => {
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  const output = await runProxy(context(), {
    localPort: 41000,
    host: "db.example.net",
    port: 5432,
    transport: "proxy",
    durationMs: 2,
  }, {
    connect: () => Promise.resolve(channel),
    createServer: ((_options: unknown, onConnection: typeof accept) => {
      accept = onConnection;
      return server;
    }) as unknown as typeof net.createServer,
  });
  assertEquals(output.acceptedConnections, 1);
  assertEquals(output.completedConnections, 1);
  assertEquals(channel.closed, true);
  assertEquals(socket.destroyed, true);
});

Deno.test("proxy duration treats active-channel abort of an established tunnel as cleanup", async () => {
  let reads = 0;
  let rejectRead: ((error: Error) => void) | undefined;
  let channelClosed = false;
  const channel: Channel = {
    read: () => {
      reads++;
      if (reads === 1) return Promise.resolve(text({ status: "connected" }));
      return new Promise<Message | null>((_resolve, reject) => {
        rejectRead = reject;
      });
    },
    send: () => Promise.resolve(),
    close: () => {
      channelClosed = true;
      rejectRead?.(new Error("active channel aborted before socket close"));
    },
    closeCode: () => undefined,
  };
  const socket = new PassThrough();
  let accept: (socket: net.Socket) => void = () => {};
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (_options, callback) => {
    server.listening = true;
    callback();
    accept(socket as unknown as net.Socket);
    return server;
  };
  server.close = (callback) => {
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  const output = await runProxy(context(), {
    localPort: 41000,
    host: "db.example.net",
    port: 5432,
    transport: "proxy",
    durationMs: 2,
  }, {
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
  });
  assertEquals(output.acceptedConnections, 1);
  assertEquals(output.completedConnections, 1);
  assertEquals(channelClosed, true);
  assertEquals(socket.destroyed, true);
});

Deno.test("proxy global timeout expires a pending handshake and closes every owner", async () => {
  const channel = new FakeChannel([]);
  const socket = new PassThrough();
  let accept: (socket: net.Socket) => void = () => {};
  let listenerClosed = false;
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (_options, callback) => {
    server.listening = true;
    callback();
    accept(socket as unknown as net.Socket);
    return server;
  };
  server.close = (callback) => {
    listenerClosed = true;
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  await assertRejects(
    () =>
      runProxy(context(undefined, { timeoutMs: 2 }), {
        localPort: 41000,
        host: "db.example.net",
        port: 5432,
        transport: "proxy",
        durationMs: 1_000,
      }, {
        connect: () => Promise.resolve(channel),
        createServer: ((_options: unknown, onConnection: typeof accept) => {
          accept = onConnection;
          return server;
        }) as unknown as typeof net.createServer,
      }),
    Error,
    "timeoutMs",
  );
  assertEquals(listenerClosed, true);
  assertEquals(channel.closed, true);
  assertEquals(socket.destroyed, true);
});

Deno.test("proxy gives late connections the remaining deadline and aggregate queue share", async () => {
  const socket = new PassThrough();
  const channel = new FakeChannel([text({ status: "connected" })]);
  let accept: (socket: net.Socket) => void = () => {};
  let connectionTimeoutMs = 0;
  let connectionMaxResponseBytes = 0;
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (_options, callback) => {
    server.listening = true;
    callback();
    setTimeout(() => accept(socket as unknown as net.Socket), 10);
    return server;
  };
  server.close = (callback) => {
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  const ctx = context(undefined, {
    timeoutMs: 200,
    maxResponseBytes: 8 * 1024 * 1024,
  });
  const output = await runProxy(ctx, {
    localPort: 41000,
    host: "db.example.net",
    port: 5432,
    transport: "proxy",
    durationMs: 30,
    maxConnections: 1_024,
  }, {
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
  });
  assertEquals(output.acceptedConnections, 1);
  assertEquals(connectionMaxResponseBytes, 128 * 1024);
  assertEquals(connectionTimeoutMs > 0, true);
  assertEquals(connectionTimeoutMs < 200, true);
  assertEquals(ctx.globalArgs.maxResponseBytes, 8 * 1024 * 1024);
  assertEquals(channel.closed, true);
  assertEquals(socket.destroyed, true);
});

Deno.test("proxy schema defaults to exec while binding only loopback", async () => {
  let listenOptions: net.ListenOptions | undefined;
  let closed = false;
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    listen(options: net.ListenOptions, callback: () => void): unknown;
    close(callback: () => void): unknown;
  };
  server.listening = false;
  server.listen = (options, callback) => {
    listenOptions = options;
    server.listening = true;
    queueMicrotask(callback);
    return server;
  };
  server.close = (callback) => {
    closed = true;
    server.listening = false;
    queueMicrotask(callback);
    return server;
  };
  const output = await runProxy(context(), {
    localPort: 41000,
    host: "db.example.net",
    port: 5432,
    durationMs: 1,
  }, {
    createServer: (() => server) as unknown as typeof net.createServer,
  });
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
    transport: "exec",
    acceptedConnections: 0,
    completedConnections: 0,
    rejectedConnections: 0,
    bytesFromClients: 0,
    bytesFromRemote: 0,
    durationMs: 1,
    closed: true,
  });
});

for (const finish of ["duration", "cancel", "failure"] as const) {
  Deno.test(`proxy caps connections and closes active tunnels after ${finish}`, async () => {
    const controller = new AbortController();
    const channel = new FakeChannel([text({ status: "connected" })]);
    const sockets = [new PassThrough(), new PassThrough()];
    let connections = 0;
    let connectedPath: string | undefined;
    const server = new EventEmitter() as EventEmitter & {
      listening: boolean;
      listen(options: net.ListenOptions, callback: () => void): unknown;
      close(callback: () => void): unknown;
    };
    server.listening = false;
    let accept: (socket: net.Socket) => void;
    server.listen = (_options, callback) => {
      server.listening = true;
      queueMicrotask(() => {
        callback();
        queueMicrotask(() => {
          for (const socket of sockets) accept(socket as unknown as net.Socket);
        });
      });
      return server;
    };
    server.close = (callback) => {
      server.listening = false;
      queueMicrotask(callback);
      return server;
    };
    const pending = runProxy(context(controller.signal), {
      localPort: 41000,
      host: "db.example.net",
      port: 5432,
      transport: "control",
      durationMs: 30,
      maxConnections: 1,
    }, {
      connect: (_ctx, path) => {
        connections++;
        connectedPath = path;
        return Promise.resolve(channel);
      },
      createServer: ((_options: unknown, onConnection: typeof accept) => {
        accept = onConnection;
        return server;
      }) as unknown as typeof net.createServer,
    });
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
        assertEquals(output.transport, "control");
      } else {
        await assertRejects(
          () => pending,
          Error,
          finish === "cancel" ? "cancelled" : "connection failed",
        );
      }
      assertEquals(connections, 1);
      assertEquals(connectedPath, "/v1/sprites/demo%20sprite/control");
      assertEquals(
        channel.sent[0],
        `control:${
          JSON.stringify({
            type: "op.start",
            op: "proxy",
            args: { host: "db.example.net", port: "5432" },
          })
        }`,
      );
      assertEquals(server.listening, false);
      assertEquals(channel.closed, true);
      assertEquals(sockets.every((socket) => socket.destroyed), true);
    } finally {
      clearTimeout(timer);
    }
  });
}

Deno.test("proxy stops reading remote frames when its consumer applies backpressure", async () => {
  let reads = 0;
  const channel = new FakeChannel([text({ status: "connected" }), {
    binary: true,
    bytes: new Uint8Array(1_000_000),
  }, { binary: true, bytes: new Uint8Array(1_000_000) }]);
  const originalRead = channel.read.bind(channel);
  channel.read = () => {
    reads++;
    return originalRead();
  };
  const stream = await connectProxy(
    context(),
    "db.example.net",
    5432,
    () => Promise.resolve(channel),
  );
  try {
    stream.read(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(reads, 2);
    assertEquals(stream.readableLength, 1_000_000);
  } finally {
    stream.destroy();
  }
  assertEquals(channel.closed, true);
});

Deno.test("streaming timeout schema keeps the five-minute default and timer-safe maximum", () => {
  assertEquals(
    SpriteArgsSchema.parse({ token: "token", name: "sprite" }).timeoutMs,
    300_000,
  );
  assertEquals(
    SpriteArgsSchema.safeParse({
      token: "token",
      name: "sprite",
      timeoutMs: 2_147_483_647,
    }).success,
    true,
  );
  assertEquals(
    SpriteArgsSchema.safeParse({
      token: "token",
      name: "sprite",
      timeoutMs: 2_147_483_648,
    }).success,
    false,
  );
});

Deno.test("streaming exports compose watch and proxy declarations", async () => {
  assertEquals(Object.keys(streamingMethods), ["watch", "proxy"]);
  assertEquals(Object.keys(streamingResources), ["watchEvents", "proxy"]);
  await assertRejects(
    () =>
      streamingMethods.watch.execute(
        { paths: ["."], durationMs: 0 },
        context(),
      ),
    Error,
  );
});
