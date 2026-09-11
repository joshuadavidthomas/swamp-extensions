// SPDX-License-Identifier: MIT
/** HTTP/1.1 exec decoding that preserves provider HTTP chunk boundaries. @module */
import { connect as connectTls } from "node:tls";
import { Readable } from "node:stream";
import { apiUrl, concatenate, type Query } from "./core.ts";
import { type SpriteContext, spritePath } from "./sprite-api.ts";

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
  ctx: SpriteContext,
  query: Query,
  input = new Uint8Array(),
  connect: typeof connectTls = connectTls,
): Promise<CommandResult> {
  const url = apiUrl(ctx.globalArgs, spritePath(ctx, "/exec"), query);
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
