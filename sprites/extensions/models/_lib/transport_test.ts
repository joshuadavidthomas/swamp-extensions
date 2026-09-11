// SPDX-License-Identifier: MIT
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { Buffer } from "node:buffer";
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket, { WebSocketServer } from "ws";
import { executeHttp } from "./exec-http.ts";
import { requestGateway } from "./gateway.ts";
import { openChannel, type SocketFactory } from "./socket.ts";
import { SpriteArgsSchema, type SpriteContext } from "./sprite-api.ts";
import { connectExecProxy, ProxyArgs, runProxy } from "./proxy.ts";
import { testContext } from "./test_support.ts";

async function certificateFixture(): Promise<{
  cert: string;
  key: string;
  cleanup(): void;
}> {
  const directory = await Deno.makeTempDir({ prefix: "sprites-transport-" });
  const certPath = `${directory}/cert.pem`;
  const keyPath = `${directory}/key.pem`;
  const command = new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=api.sprites.dev",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:api.sprites.dev",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    await Deno.remove(directory, { recursive: true });
    throw new Error(
      `openssl failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  return {
    cert: await Deno.readTextFile(certPath),
    key: await Deno.readTextFile(keyPath),
    cleanup: () => Deno.removeSync(directory, { recursive: true }),
  };
}

const fixture = await certificateFixture();
addEventListener("unload", () => {
  fixture.cleanup();
});

function listen(server: https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("HTTPS fixture did not bind a TCP port."));
      } else resolve(address.port);
    });
  });
}

function closeServer(server: https.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

async function reserveTcpPort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("TCP fixture did not bind a port."));
      } else resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  return port;
}

async function connectTcp(port: number): Promise<net.Socket> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        const onError = (error: Error): void => {
          socket.off("connect", onConnect);
          socket.destroy();
          reject(error);
        };
        const onConnect = (): void => {
          socket.off("error", onError);
          resolve(socket);
        };
        socket.once("error", onError);
        socket.once("connect", onConnect);
      });
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error("TCP connect failed.");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw lastError ?? new Error("TCP fixture did not accept a connection.");
}

function context(
  port: number,
  signal = new AbortController().signal,
): SpriteContext {
  return testContext(
    SpriteArgsSchema.parse({
      token: "placeholder",
      baseUrl: `https://127.0.0.1:${port}`,
      timeoutMs: 5_000,
      maxResponseBytes: 1_000_000,
      name: "worker",
    }),
    { signal, storedResources: { state: { id: "fixture-sprite" } } },
  );
}

Deno.test("openChannel uses real TLS and WebSocket framing, graceful close, and cancellation", async () => {
  const server = https.createServer({ cert: fixture.cert, key: fixture.key });
  const webSockets = new WebSocketServer({ server });
  const requests: Array<{ url?: string; authorization?: string }> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  webSockets.on("connection", (socket, request) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
    });
    socket.on(
      "close",
      (code, reason) => closes.push({ code, reason: reason.toString() }),
    );
    if (request.url?.includes("cancel=1")) return;
    socket.send("control");
    socket.send(Buffer.from([0, 255, 7]), { binary: true });
  });
  try {
    const port = await listen(server);
    const factory: SocketFactory = (url, options) =>
      new WebSocket(url, { ...options, ca: fixture.cert });
    const channel = await openChannel(
      context(port),
      "/v1/sprites/worker/fs/watch",
      { item: ["one", "two"] },
      factory,
    );
    assertEquals(await channel.read(), {
      binary: false,
      bytes: new TextEncoder().encode("control"),
    });
    assertEquals(await channel.read(), {
      binary: true,
      bytes: new Uint8Array([0, 255, 7]),
    });
    const firstClose = channel.close();
    const secondClose = channel.close();
    assertStrictEquals(firstClose, secondClose);
    await firstClose;

    const controller = new AbortController();
    const cancelled = await openChannel(
      context(port, controller.signal),
      "/v1/sprites/worker/fs/watch",
      { cancel: 1 },
      factory,
    );
    const pendingRead = cancelled.read();
    controller.abort();
    await assertRejects(() => pendingRead, Error, "cancelled");
    const cancelledClose = cancelled.close();
    assertStrictEquals(cancelledClose, cancelled.close());
    await cancelledClose;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assertEquals(requests.length, 2);
    for (const request of requests) {
      assertEquals(request.authorization, "Bearer placeholder");
      assert(!request.url?.includes("placeholder"));
    }
    assertEquals(
      requests[0].url,
      "/v1/sprites/worker/fs/watch?item=one&item=two",
    );
    assertEquals(closes, [
      { code: 1000, reason: "" },
      { code: 1000, reason: "" },
    ]);
  } finally {
    for (const socket of webSockets.clients) socket.terminate();
    webSockets.close();
    await closeServer(server);
  }
});

Deno.test("openChannel bounds queued empty frames", async () => {
  const server = https.createServer({ cert: fixture.cert, key: fixture.key });
  const webSockets = new WebSocketServer({ server });
  let resolveSent: () => void = () => {};
  const sent = new Promise<void>((resolve) => {
    resolveSent = resolve;
  });
  webSockets.on("connection", (socket) => {
    for (let index = 0; index < 1_025; index++) {
      socket.send(Buffer.alloc(0), { binary: true }, () => {
        if (index === 1_024) resolveSent();
      });
    }
  });
  try {
    const port = await listen(server);
    const factory: SocketFactory = (url, options) =>
      new WebSocket(url, { ...options, ca: fixture.cert });
    const channel = await openChannel(
      context(port),
      "/v1/sprites/worker/proxy",
      {},
      factory,
    );
    await sent;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await assertRejects(() => channel.read(), Error, "frame limit");
    await channel.close();
  } finally {
    for (const socket of webSockets.clients) socket.terminate();
    webSockets.close();
    await closeServer(server);
  }
});

Deno.test("openChannel drops a large backpressured queue as soon as its byte limit fails", async () => {
  const server = https.createServer({ cert: fixture.cert, key: fixture.key });
  const webSockets = new WebSocketServer({ server });
  let resolveSent: () => void = () => {};
  const sent = new Promise<void>((resolve) => {
    resolveSent = resolve;
  });
  webSockets.on("connection", (socket) => {
    for (let index = 0; index < 3; index++) {
      socket.send(Buffer.alloc(64 * 1024), { binary: true }, () => {
        if (index === 2) resolveSent();
      });
    }
  });
  try {
    const port = await listen(server);
    const ctx = context(port);
    ctx.globalArgs.maxResponseBytes = 128 * 1024;
    const factory: SocketFactory = (url, options) =>
      new WebSocket(url, { ...options, ca: fixture.cert });
    const channel = await openChannel(
      ctx,
      "/v1/sprites/worker/proxy",
      {},
      factory,
    );
    await sent;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A non-draining limit failure must reject before exposing any old frame.
    await assertRejects(() => channel.read(), Error, "maxResponseBytes");
    await channel.close();
  } finally {
    for (const socket of webSockets.clients) socket.terminate();
    webSockets.close();
    await closeServer(server);
  }
});

const sprite = {
  id: "fixture-sprite",
  name: "worker",
  organization: "org",
  url: "https://worker.example",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  url_settings: null,
  version: null,
  environment_version: null,
};

Deno.test("runProxy delivers close-delimited responses before bounded cleanup", async () => {
  const outer = https.createServer({ cert: fixture.cert, key: fixture.key });
  const webSockets = new WebSocketServer({ server: outer });
  const body = Buffer.alloc(128 * 1_024);
  for (let index = 0; index < body.length; index++) body[index] = index % 251;
  const response = Buffer.concat([
    Buffer.from("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"),
    body,
  ]);
  let pendingHandshakeClosed = false;
  let pendingHandshakeStarted = false;
  webSockets.on("connection", (socket, request) => {
    const command = new URL(request.url!, "https://fixture").searchParams
      .getAll("cmd");
    const pending = command.includes("pending.internal");
    let responded = false;
    if (pending) pendingHandshakeStarted = true;
    else {socket.send(
        Buffer.concat([Buffer.from([2]), Buffer.from("connected\n")]),
      );}
    socket.on("close", () => {
      if (pending) pendingHandshakeClosed = true;
    });
    socket.on("message", (data, binary) => {
      if (pending || !binary || responded || (data as Buffer)[0] !== 0) return;
      responded = true;
      socket.send(Buffer.from([1]), { binary: true });
      for (let offset = 0; offset < response.length; offset += 8_192) {
        const chunk = response.subarray(
          offset,
          Math.min(offset + 8_192, response.length),
        );
        socket.send(Buffer.concat([Buffer.from([1]), chunk]), { binary: true });
      }
      socket.send(Buffer.from([3, 0]), { binary: true });
    });
  });
  const { calls } = await withMockedFetch(
    Array.from({ length: 2 }, () =>
      new Response(JSON.stringify(sprite), {
        headers: { "content-type": "application/json" },
      })),
    async () => {
      try {
        const outerPort = await listen(outer);
        const ctx = context(outerPort);
        const connectWithCa: typeof openChannel = (
          channelContext,
          path,
          query = {},
        ) =>
          openChannel(
            channelContext,
            path,
            query,
            (url, options) =>
              new WebSocket(url, { ...options, ca: fixture.cert }),
          );

        {
          const localPort = await reserveTcpPort();
          let proxySettled = false;
          const proxy = runProxy(
            ctx,
            ProxyArgs.parse({
              localPort,
              host: "service.internal",
              port: 8080,
              durationMs: 1_000,
            }),
            { connect: connectWithCa },
          ).finally(() => {
            proxySettled = true;
          });
          void proxy.catch(() => {});
          const client = await connectTcp(localPort);
          client.pause();
          const received: Buffer[] = [];
          const ended = new Promise<void>((resolve, reject) => {
            client.on("data", (chunk) => received.push(Buffer.from(chunk)));
            client.once("end", resolve);
            client.once("error", reject);
          });
          client.write("GET /close-delimited HTTP/1.1\r\nHost: local\r\n\r\n");
          await new Promise((resolve) => setTimeout(resolve, 20));
          client.resume();
          await ended;
          assertEquals(proxySettled, false);
          assertEquals(Buffer.concat(received), response);
          client.destroy();
          const output = await proxy;
          assertEquals(output.acceptedConnections, 1);
          assertEquals(output.completedConnections, 1);
          assertEquals(output.bytesFromRemote, response.length);
        }

        const localPort = await reserveTcpPort();
        let pendingProxySettled = false;
        const pendingProxy = runProxy(
          ctx,
          ProxyArgs.parse({
            localPort,
            host: "pending.internal",
            port: 8080,
            durationMs: 500,
          }),
          { connect: connectWithCa },
        ).finally(() => {
          pendingProxySettled = true;
        });
        void pendingProxy.catch(() => {});
        const client = await connectTcp(localPort);
        for (
          let attempt = 0;
          attempt < 50 && !pendingHandshakeStarted;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assertEquals(pendingHandshakeStarted, true);
        client.destroy();
        for (
          let attempt = 0;
          attempt < 50 && !pendingHandshakeClosed;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assertEquals(pendingHandshakeClosed, true);
        assertEquals(pendingProxySettled, false);
        const output = await pendingProxy;
        assertEquals(output.acceptedConnections, 1);
        assertEquals(output.completedConnections, 1);
      } finally {
        for (const socket of webSockets.clients) socket.terminate();
        webSockets.close();
        await closeServer(outer);
      }
    },
  );
  assertEquals(calls.length, 2);
});

Deno.test("executeHttp uses real hostname-checked TLS and decodes exact HTTP chunks", async () => {
  let requestUrl = "";
  let authorization = "";
  let requestBody = new Uint8Array();
  const server = https.createServer(
    { cert: fixture.cert, key: fixture.key },
    async (request, response) => {
      requestUrl = request.url ?? "";
      authorization = request.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = new Uint8Array(Buffer.concat(chunks));
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
      });
      response.write(Buffer.from([1, 0, 255]));
      response.write(Buffer.from([2, 9, 8]));
      response.write(Buffer.from([3, 3]));
      response.end();
    },
  );
  try {
    const port = await listen(server);
    const input = new Uint8Array([0, 4, 255]);
    const ctx = context(port);
    ctx.globalArgs.baseUrl = `https://api.sprites.dev:${port}`;
    let tlsOptions: tls.ConnectionOptions | undefined;
    const result = await executeHttp(
      ctx,
      { cmd: ["printf", "a b"], env: ["A=1", "B=two"] },
      input,
      ((options: tls.ConnectionOptions) => {
        tlsOptions = options;
        return tls.connect({
          ...options,
          host: "127.0.0.1",
          ca: fixture.cert,
        });
      }) as typeof tls.connect,
    );
    assertEquals(tlsOptions?.servername, "api.sprites.dev");
    assertEquals(tlsOptions?.rejectUnauthorized, true);
    assertEquals(
      requestUrl,
      "/v1/sprites/worker/exec?cmd=printf&cmd=a+b&env=A%3D1&env=B%3Dtwo",
    );
    assertEquals(authorization, "Bearer placeholder");
    assertEquals(requestBody, input);
    assertEquals(result, {
      stdout: new Uint8Array([0, 255]),
      stderr: new Uint8Array([9, 8]),
      exitCode: 3,
    });
    const empty = await executeHttp(
      ctx,
      { cmd: ["true"] },
      new Uint8Array(),
      ((options: tls.ConnectionOptions) => {
        const socket = tls.connect({
          ...options,
          host: "127.0.0.1",
          ca: fixture.cert,
        });
        const write = socket.write.bind(socket);
        socket.write = ((...args: Parameters<typeof socket.write>) => {
          assert(
            (args[0] as Uint8Array).length > 0,
            "Do not write an empty stdin chunk after request headers.",
          );
          return write(...args);
        }) as typeof socket.write;
        return socket;
      }) as typeof tls.connect,
    );
    assertEquals(requestBody.length, 0);
    assertEquals(empty.exitCode, 3);
  } finally {
    await closeServer(server);
  }
});

Deno.test("requestGateway crosses the real WebSocket proxy and a validated inner TLS session", async () => {
  let innerAuthorization: string | undefined;
  let innerBody = new Uint8Array();
  const gateway = https.createServer(
    { cert: fixture.cert, key: fixture.key },
    async (request, response) => {
      innerAuthorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      innerBody = new Uint8Array(Buffer.concat(chunks));
      response.setHeader("set-cookie", ["one=1", "two=2"]);
      response.writeHead(207, "Multi-Status");
      response.end(Buffer.from([0, 254, 3]));
    },
  );
  const outer = https.createServer({ cert: fixture.cert, key: fixture.key });
  const webSockets = new WebSocketServer({
    server: outer,
    path: "/v1/sprites/worker/exec",
  });
  const outerAuth: Array<string | undefined> = [];
  const targets: unknown[] = [];
  const tcpSockets = new Set<net.Socket>();
  let gatewayPort = 0;
  webSockets.on("connection", (socket, request) => {
    outerAuth.push(request.headers.authorization);
    const command = new URL(request.url!, "https://fixture").searchParams
      .getAll("cmd");
    targets.push({ host: command[5], port: Number(command[6]) });
    const upstream = net.connect(
      gatewayPort,
      "127.0.0.1",
      () =>
        socket.send(
          Buffer.concat([Buffer.from([2]), Buffer.from("connected\n")]),
        ),
    );
    tcpSockets.add(upstream);
    upstream.on(
      "data",
      (chunk: Buffer) =>
        socket.send(Buffer.concat([Buffer.from([1]), chunk]), { binary: true }),
    );
    upstream.on("end", () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(Buffer.from([3, 0]));
      }
    });
    upstream.on("close", () => tcpSockets.delete(upstream));
    upstream.on("error", () => socket.terminate());
    socket.on("message", (data, binary) => {
      if (!binary) return;
      const frame = data as Buffer;
      if (frame[0] === 0) upstream.write(frame.subarray(1));
      else if (frame[0] === 4) upstream.end();
    });
    socket.on("close", () => upstream.destroy());
  });
  try {
    gatewayPort = await listen(gateway);
    const outerPort = await listen(outer);
    const ctx = context(outerPort);
    const caConnect: typeof openChannel = (
      channelContext,
      path,
      query = {},
    ) =>
      openChannel(
        channelContext,
        path,
        query,
        (url, options) => new WebSocket(url, { ...options, ca: fixture.cert }),
      );
    const result = await requestGateway(ctx, {
      method: "POST",
      path: "/v1/gateway/demo",
      headers: {
        "content-type": "application/octet-stream",
        "x-inner": "kept",
      },
      body: new Uint8Array([0, 255, 4]),
    }, {
      connect: (connectContext, host, port) =>
        connectExecProxy(connectContext, host, port, caConnect),
      connectTls: ((options: tls.ConnectionOptions) =>
        tls.connect({ ...options, ca: fixture.cert })) as typeof tls.connect,
    });

    assertEquals(targets, [{ host: "api.sprites.dev", port: 443 }]);
    assertEquals(outerAuth, ["Bearer placeholder"]);
    assertEquals(innerAuthorization, undefined);
    assertEquals(innerBody, new Uint8Array([0, 255, 4]));
    assertEquals(result.status, 207);
    assertEquals(result.statusText, "Multi-Status");
    assertEquals(result.headers["set-cookie"], ["one=1", "two=2"]);
    assertEquals(result.body, new Uint8Array([0, 254, 3]));
  } finally {
    for (const socket of webSockets.clients) socket.terminate();
    for (const socket of tcpSockets) socket.destroy();
    webSockets.close();
    await closeServer(outer);
    await closeServer(gateway);
  }
});
