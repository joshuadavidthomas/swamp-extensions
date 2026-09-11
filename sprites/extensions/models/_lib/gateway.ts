// SPDX-License-Identifier: MIT
/** Connector gateway discovery and provider relay originating inside one Sprite. @module */
import { Buffer } from "node:buffer";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import * as tls from "node:tls";
import { z } from "zod";
import {
  BinaryFile,
  concatenate,
  deadline,
  Input,
  inputBytes,
  method,
  resource,
  segment,
  withHandles,
} from "./core.ts";
import { type SpriteContext, verifySprite } from "./sprite.ts";
import { connectExecProxy } from "./proxy.ts";

const GATEWAY_HOST = "api.sprites.dev";
const GATEWAY_PORT = 443;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const GatewayConnection = z.looseObject({
  provider: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  gateway_base_url: z.string().optional(),
  scopes: z.json().optional(),
  usage_snippet: z.string().optional(),
  request_scopes_url: z.string().optional(),
}).describe(
  "Source-defined configured gateway entry. Known fields are typed and unpublished provider metadata is retained.",
);
const GatewayList = z.object({
  connections: z.array(GatewayConnection),
  available: z.array(
    z.looseObject({
      setup_url: z.string().optional(),
    }).describe(
      "Source-defined available-provider entry. setup_url is known and unpublished provider metadata is retained.",
    ),
  ),
});

const ProviderMethod = z.string().regex(HTTP_TOKEN).refine(
  (value) => value.toUpperCase() !== "CONNECT",
  "CONNECT establishes a tunnel; use proxy instead of the HTTP relay.",
);
function validProviderPath(value: string): boolean {
  if (
    !value.startsWith("/") || value.startsWith("//") || /[\\\r\n#]/.test(value)
  ) return false;
  const pathname = value.split("?", 1)[0];
  try {
    return pathname.split("/").every((part) => {
      const decoded = decodeURIComponent(part);
      return decoded !== "." && decoded !== ".." && !decoded.includes("/") &&
        !decoded.includes("\\");
    });
  } catch {
    return false;
  }
}

const GatewayRequestArgs = z.object({
  provider: z.string().min(1),
  connection_id: z.string().min(1),
  providerPath: z.string().min(1).refine(
    validProviderPath,
    "providerPath must be an absolute provider path without a host, traversal, fragment, or header sequence.",
  ),
  method: ProviderMethod,
  headers: z.record(z.string(), z.string()).meta({ sensitive: true }).default(
    {},
  ),
  input: Input.optional().meta({ sensitive: true }),
});
const GatewayResponse = z.object({
  status: z.number().int().min(100).max(599),
  statusText: z.string(),
  headers: z.record(z.string(), z.array(z.string())).meta({ sensitive: true }),
  bodyBytes: z.number().int().nonnegative(),
});

type GatewayHttpRequest = {
  method: z.output<typeof ProviderMethod>;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
};
/** Raw gateway response before its binary body is persisted. */
export type GatewayHttpResponse = z.output<typeof GatewayResponse> & {
  body: Uint8Array;
};
/** Injectable TCP, TLS, and HTTPS boundaries used by gateway protocol tests. */
export type GatewayDependencies = {
  connect?: typeof connectExecProxy;
  connectTls?: typeof tls.connect;
  request?: typeof https.request;
};

const BLOCKED_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "trailer",
  "te",
  "expect",
  "fly-src",
]);

function checkedHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (BLOCKED_HEADERS.has(normalized) || normalized.startsWith("fly-src-")) {
      throw new Error(
        `Gateway request header ${name} is controlled by the gateway transport.`,
      );
    }
    if (!HTTP_TOKEN.test(name) || /[\r\n]/.test(value)) {
      throw new Error("Gateway request contains an invalid HTTP header.");
    }
  }
  return headers;
}

async function secureTunnel(
  ctx: SpriteContext,
  dependencies: GatewayDependencies,
): Promise<{ raw: Duplex; socket: tls.TLSSocket }> {
  const raw = await (dependencies.connect ?? connectExecProxy)(
    ctx,
    GATEWAY_HOST,
    GATEWAY_PORT,
  );
  let socket: tls.TLSSocket;
  try {
    socket = (dependencies.connectTls ?? tls.connect)({
      socket: raw,
      servername: GATEWAY_HOST,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
  } catch (error) {
    raw.destroy();
    throw error;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off("secureConnect", onSecure);
        socket.off("error", onError);
        ctx.signal.removeEventListener("abort", onAbort);
      };
      const onSecure = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("Gateway TLS handshake failed."));
      };
      const onAbort = (): void => {
        cleanup();
        reject(ctx.signal.reason);
      };
      socket.once("secureConnect", onSecure);
      socket.once("error", onError);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();
    });
    return { raw, socket };
  } catch (error) {
    socket.destroy();
    raw.destroy();
    throw error;
  }
}

class TunnelAgent extends https.Agent {
  constructor(private readonly tunnel: tls.TLSSocket) {
    super({ keepAlive: false, maxSockets: 1 });
  }

  override createConnection(
    _options: https.RequestOptions,
  ): Duplex {
    return this.tunnel;
  }
}

/** Send one ordinary HTTPS request over a TLS session carried by the Sprite proxy. */
export async function requestGateway(
  ctx: SpriteContext,
  request: GatewayHttpRequest,
  dependencies: GatewayDependencies = {},
): Promise<GatewayHttpResponse> {
  const { signal, dispose } = deadline(ctx);
  try {
    signal.throwIfAborted();
    const { raw, socket } = await secureTunnel(
      { ...ctx, signal },
      dependencies,
    );
    const agent = new TunnelAgent(socket);
    let outgoing: ReturnType<typeof https.request> | undefined;
    const onAbort = (): void => {
      outgoing?.destroy(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const incoming = await new Promise<IncomingMessage>((resolve, reject) => {
        outgoing = (dependencies.request ?? https.request)({
          protocol: "https:",
          hostname: GATEWAY_HOST,
          port: String(GATEWAY_PORT),
          method: request.method,
          path: request.path,
          headers: request.headers,
          agent,
        }, resolve);
        outgoing.once(
          "error",
          () => reject(new Error("Gateway HTTPS transport failed.")),
        );
        outgoing.end(Buffer.from(request.body));
        if (signal.aborted) onAbort();
      });
      if (
        incoming.statusCode === undefined ||
        incoming.statusMessage === undefined
      ) {
        incoming.destroy();
        throw new Error(
          "Gateway HTTPS transport returned an incomplete HTTP status.",
        );
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const value of incoming) {
        const chunk = new Uint8Array(value as Buffer);
        length += chunk.length;
        if (length > ctx.globalArgs.maxResponseBytes) {
          incoming.destroy();
          throw new Error(
            `Gateway response exceeds maxResponseBytes (${ctx.globalArgs.maxResponseBytes}); no complete output was saved.`,
          );
        }
        chunks.push(chunk);
      }
      const body = concatenate(chunks);
      return {
        status: incoming.statusCode,
        statusText: incoming.statusMessage,
        // Node declares optional values, but parsed distinct headers are arrays.
        headers: incoming.headersDistinct as Record<string, string[]>,
        bodyBytes: body.length,
        body,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      outgoing?.destroy();
      agent.destroy();
      socket.destroy();
      raw.destroy();
    }
  } finally {
    dispose();
  }
}

/** Injectable complete gateway request boundary for schema and relay tests. */
export type GatewayRequester = (
  ctx: SpriteContext,
  request: GatewayHttpRequest,
) => Promise<GatewayHttpResponse>;

/** Discover source-defined connector metadata through the Sprite tunnel. */
export async function discoverGateway(
  ctx: SpriteContext,
  requester: GatewayRequester = requestGateway,
): Promise<z.output<typeof GatewayList>> {
  const response = await requester(ctx, {
    method: "GET",
    path: "/v1/gateway/list",
    headers: { accept: "application/json" },
    body: new Uint8Array(),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Sprite gateway discovery returned HTTP ${response.status}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.body),
    );
  } catch {
    throw new Error(
      "Sprite gateway discovery returned invalid JSON.",
    );
  }
  const parsed = GatewayList.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Sprite gateway discovery response does not match its source-defined schema.",
    );
  }
  return parsed.data;
}

/** Build and send one provider relay while keeping the destination on the fixed gateway host. */
export async function relayGateway(
  ctx: SpriteContext,
  args: z.output<typeof GatewayRequestArgs>,
  requester: GatewayRequester = requestGateway,
): Promise<GatewayHttpResponse> {
  const body = inputBytes(args.input);
  if (body.length > ctx.globalArgs.maxResponseBytes) {
    throw new Error(
      `Gateway request body exceeds maxResponseBytes (${ctx.globalArgs.maxResponseBytes}).`,
    );
  }
  return await requester(ctx, {
    method: args.method,
    path: `/v1/gateway/${segment(args.provider)}/${
      segment(args.connection_id)
    }${args.providerPath}`,
    headers: checkedHeaders(args.headers),
    body,
  });
}

/** Gateway JSON resources for composition into the single-Sprite model. */
export const gatewayResources = {
  gatewayConnections: resource(
    GatewayList,
    "Gateway connections and available providers with source-defined open metadata",
  ),
  gatewayResponse: resource(
    GatewayResponse,
    "Provider HTTP status and response headers",
    "7d",
  ),
};

/** Binary provider response body. */
export const gatewayFiles = { gatewayBody: BinaryFile };

/** Connector gateway methods for composition into the single-Sprite model. */
export const gatewayMethods = {
  gatewayList: method(
    "Discover connector access from inside the configured Sprite",
    z.object({}),
    "gatewayConnections",
    GatewayList,
    (_args, ctx: SpriteContext) => discoverGateway(ctx),
  ),
  gatewayRequest: method(
    "Relay one provider path through a configured Sprite connector",
    GatewayRequestArgs,
    "gatewayResponse",
    GatewayResponse,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      const response = await relayGateway(ctx, args);
      ctx.signal.throwIfAborted();
      const bodyHandle = await ctx.createFileWriter(
        "gatewayBody",
        "gatewayBody",
      ).writeAll(response.body);
      return withHandles(response, [bodyHandle]);
    },
  ),
};
