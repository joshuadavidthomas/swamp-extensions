// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type * as https from "node:https";
import type * as tls from "node:tls";
import { testContext } from "./test_support.ts";
import {
  discoverGateway,
  type GatewayHttpResponse,
  gatewayMethods,
  relayGateway,
  requestGateway,
} from "./gateway.ts";

const globalArgs = {
  token: "outer-secret",
  baseUrl: "https://api.sprites.dev",
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000,
  name: "demo",
};
const ctx = testContext(globalArgs);
function response(
  overrides: Partial<GatewayHttpResponse> = {},
): GatewayHttpResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    bodyBytes: 0,
    body: new Uint8Array(),
    ...overrides,
  };
}

Deno.test("gateway supports extension methods", async () => {
  await relayGateway(
    ctx,
    gatewayMethods.gatewayRequest.arguments.parse({
      provider: "custom_api",
      connection_id: "c1",
      providerPath: "/items",
      method: "PROPFIND",
    }),
    (_ctx, request) => {
      assertEquals(request.method, "PROPFIND");
      return Promise.resolve(response({ status: 207 }));
    },
  );
});

Deno.test("gateway discovery uses the Sprite tunnel and retains open metadata", async () => {
  const body = new TextEncoder().encode(JSON.stringify({
    connections: [{
      provider: "slack",
      gateway_base_url: "/v1/gateway/slack/c1",
      unpublished: { color: "blue" },
    }],
    available: [{
      setup_url: "/setup/github",
      provider: "github",
      flags: [true, null],
    }],
  }));
  const output = await discoverGateway(ctx, (_ctx, request) => {
    assertEquals(request, {
      method: "GET",
      path: "/v1/gateway/list",
      headers: { accept: "application/json" },
      body: new Uint8Array(),
    });
    return Promise.resolve(response({ body, bodyBytes: body.length }));
  });
  assertEquals(output.connections[0].unpublished, { color: "blue" });
  assertEquals(output.available[0].flags, [true, null]);
});

Deno.test("provider relay fixes the destination, encodes identity, preserves bytes, and sends no token", async () => {
  const providerBody = new Uint8Array([0, 255, 3]);
  const result = await relayGateway(
    ctx,
    gatewayMethods.gatewayRequest.arguments.parse({
      provider: "custom/api",
      connection_id: "id one",
      providerPath: "/v2/items?q=a",
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-provider-option": "yes",
      },
      input: { kind: "base64", base64: providerBody.toBase64() },
    }),
    (_ctx, request) => {
      assertEquals(
        request.path,
        "/v1/gateway/custom%2Fapi/id%20one/v2/items?q=a",
      );
      assertEquals(request.method, "POST");
      assertEquals(request.headers, {
        "content-type": "application/octet-stream",
        "x-provider-option": "yes",
      });
      assertEquals("authorization" in request.headers, false);
      assertEquals(request.body, providerBody);
      return Promise.resolve(
        response({
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": ["2"] },
          body: new Uint8Array([7]),
          bodyBytes: 1,
        }),
      );
    },
  );
  assertEquals(result.status, 429);
  assertEquals(result.body, new Uint8Array([7]));
});

Deno.test("relay rejects credential, routing, and Fly identity headers before transport", async () => {
  for (
    const header of [
      "Authorization",
      "Cookie",
      "Proxy-Authorization",
      "Host",
      "Content-Length",
      "Fly-Src-Signature",
    ]
  ) {
    let called = false;
    const error = await assertRejects(
      async () =>
        await relayGateway(
          ctx,
          gatewayMethods.gatewayRequest.arguments.parse({
            provider: "slack",
            connection_id: "c1",
            providerPath: "/chat.postMessage",
            method: "POST",
            headers: { [header]: "forbidden" },
          }),
          () => {
            called = true;
            return Promise.resolve(response());
          },
        ),
      Error,
    );
    assertStringIncludes(error.message, "controlled");
    assertEquals(called, false);
  }
  for (
    const providerPath of [
      "//other.example/path",
      "/../../v1/sprites",
      "/%2e%2e/admin",
    ]
  ) {
    await assertRejects(
      async () =>
        await relayGateway(
          ctx,
          gatewayMethods.gatewayRequest.arguments.parse({
            provider: "slack",
            connection_id: "c1",
            providerPath,
            method: "GET",
          }),
          () => Promise.resolve(response()),
        ),
      Error,
    );
  }
});

Deno.test("requestGateway pins proxy target and validated TLS without forwarding bearer auth", async () => {
  const raw = new PassThrough();
  const secure = new PassThrough() as unknown as tls.TLSSocket;
  Object.defineProperty(secure, "authorized", { value: true });
  let tlsOptions: tls.ConnectionOptions | undefined;
  let requestOptions: https.RequestOptions | undefined;
  const result = await requestGateway(ctx, {
    method: "GET",
    path: "/v1/gateway/list",
    headers: { accept: "application/json" },
    body: new Uint8Array(),
  }, {
    connect: (_ctx, host, port) => {
      assertEquals({ host, port }, { host: "api.sprites.dev", port: 443 });
      return Promise.resolve(raw);
    },
    connectTls: ((options: tls.ConnectionOptions) => {
      tlsOptions = options;
      queueMicrotask(() => secure.emit("secureConnect"));
      return secure;
    }) as typeof tls.connect,
    request: ((
      options: https.RequestOptions,
      callback: (message: unknown) => void,
    ) => {
      requestOptions = options;
      const outgoing = new EventEmitter() as EventEmitter & {
        end(data: Uint8Array): void;
        destroy(): void;
      };
      outgoing.end = () =>
        queueMicrotask(() => {
          const incoming = Readable.from([new Uint8Array([1, 2])]) as
            & Readable
            & {
              statusCode: number;
              statusMessage: string;
              headersDistinct: Record<string, string[]>;
            };
          incoming.statusCode = 503;
          incoming.statusMessage = "Unavailable";
          incoming.headersDistinct = { "x-test": ["one", "two"] };
          callback(incoming);
        });
      outgoing.destroy = () => {};
      return outgoing;
    }) as unknown as typeof https.request,
  });
  assertEquals(tlsOptions?.servername, "api.sprites.dev");
  assertEquals(tlsOptions?.rejectUnauthorized, true);
  assertEquals(requestOptions?.hostname, "api.sprites.dev");
  assertEquals(requestOptions?.headers, { accept: "application/json" });
  assertEquals(result.status, 503);
  assertEquals(result.headers, { "x-test": ["one", "two"] });
  assertEquals(result.body, new Uint8Array([1, 2]));
});

Deno.test("gateway discovery distinguishes invalid JSON from invalid response shapes", async () => {
  for (
    const [text, message] of [
      ["{broken", "invalid JSON"],
      [
        '{"connections":null,"available":[]}',
        "does not match its source-defined schema",
      ],
    ]
  ) {
    const body = new TextEncoder().encode(text);
    await assertRejects(
      () =>
        discoverGateway(
          ctx,
          () => Promise.resolve(response({ body, bodyBytes: body.length })),
        ),
      Error,
      message,
    );
  }
});
