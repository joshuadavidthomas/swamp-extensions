// SPDX-License-Identifier: MIT
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { testContext } from "./test_support.ts";
import {
  ApiError,
  apiUrl,
  AuthSchema,
  concatenate,
  deadline,
  emptyRequest,
  InvalidResponseError,
  jsonRequest,
  method,
  ndjson,
  responseBytes,
  ResponseLimitError,
  segment,
  withHandles,
} from "./core.ts";
const ctx = {
  globalArgs: AuthSchema.parse({ token: "secret" }),
  signal: new AbortController().signal,
};
Deno.test("transport rejects insecure endpoints, path escapes, and dot identifiers", () => {
  assert(
    !AuthSchema.safeParse({
      token: "secret",
      baseUrl: "http://api.sprites.dev",
    }).success,
  );
  assertThrows(() => apiUrl(ctx.globalArgs, "https://other.example/path"));
  assertThrows(() => segment(".."));
  assertEquals(segment("a/b ?"), "a%2Fb%20%3F");
  const url = apiUrl(ctx.globalArgs, "/v1/sprites/a/exec", {
    cmd: ["echo", "a b"],
    empty: "",
    disabled: false,
    omit: undefined,
  });
  assertEquals(url.searchParams.getAll("cmd"), ["echo", "a b"]);
  assertEquals(url.searchParams.get("disabled"), "false");
  assert(!url.searchParams.has("omit"));
});
Deno.test("mutations are not replayed on transient errors or transport failure", async () => {
  for (const status of [429, 502, 503, 504]) {
    let calls = 0;
    const error = await assertRejects(() =>
      withMockedFetch(
        () => {
          calls++;
          return new Response("secret", { status });
        },
        () => emptyRequest(ctx, "POST", "/v1/sprites", { json: { name: "a" } }),
      )
    );
    assertEquals(calls, 1);
    assert(error instanceof Error);
    assert(!error.message.includes("secret"));
  }
  let calls = 0;
  await assertRejects(
    () =>
      withMockedFetch(() => {
        calls++;
        throw new Error("secret");
      }, () => emptyRequest(ctx, "POST", "/v1/sprites")),
    Error,
    "may have accepted",
  );
  assertEquals(calls, 1);
});
Deno.test("JSON boundary validates without echoing response payloads", async () => {
  const schemaError = await assertRejects(
    () =>
      withMockedFetch(
        [new Response('{"unexpected":"secret"}')],
        () =>
          jsonRequest(
            ctx,
            "GET",
            "/v1/sprites/a",
            z.object({ id: z.string() }),
          ),
      ),
    InvalidResponseError,
    "invalid JSON response",
  );
  assert(schemaError.message.includes("id: invalid_type"));
  assert(!schemaError.message.includes("secret"));
  const error = await assertRejects(() =>
    withMockedFetch(
      [new Response("secret")],
      () =>
        jsonRequest(ctx, "GET", "/v1/sprites/a", z.object({ id: z.string() })),
    )
  );
  assert(error instanceof InvalidResponseError);
  assert(!error.message.includes("secret"));
});
Deno.test("JSON diagnostics bound and sanitize provider-controlled record keys", async () => {
  const key = "secret\n\u2028\u202e" + "x".repeat(10_000);
  const error = await assertRejects(() =>
    withMockedFetch(
      [new Response(JSON.stringify({ [key]: 1 }))],
      () =>
        jsonRequest(ctx, "GET", "/records", z.record(z.string(), z.string())),
    )
  );
  assert(error instanceof InvalidResponseError);
  assert(error.message.length < 400);
  assert(error.message.includes("[redacted]"));
  assert(!error.message.includes("secret"));
  assert(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(error.message));
});
Deno.test("JSON rejects invalid UTF-8 instead of saving replacement characters", async () => {
  // JSON string containing one invalid UTF-8 byte.
  const wire = new Uint8Array([34, 255, 34]);
  await assertRejects(
    () =>
      withMockedFetch(
        [new Response(wire)],
        () => jsonRequest(ctx, "GET", "/value", z.string()),
      ),
    InvalidResponseError,
    "invalid JSON response",
  );
});
Deno.test("response byte limits cancel streams instead of returning partial files", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255, 128]));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assertRejects(
    () => responseBytes(response, 2),
    Error,
    "maxResponseBytes",
  );
  assert(cancelled);
});
Deno.test("NDJSON handles split Unicode, blank lines, and in-band errors", async () => {
  const event = z.object({ type: z.string(), data: z.string() });
  const wire = new TextEncoder().encode(
    '\n{"type":"info","data":"雪"}\n{"type":"complete","data":"done"}\n',
  );
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of wire) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
  const result = await withMockedFetch(
    [response],
    () => ndjson(ctx, "POST", "/stream", event),
  );
  assertEquals(result.result[0].data, "雪");
  await assertRejects(
    () =>
      withMockedFetch(
        [new Response('{"type":"error","data":"secret"}\n')],
        () => ndjson(ctx, "POST", "/stream", event),
      ),
    Error,
    "reported an error",
  );
});

Deno.test("HTTP errors retain status and release the body even when cancellation aborts the signal", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const error = await assertRejects(
    () =>
      withMockedFetch(
        () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
                controller.abort();
              },
            }),
            { status: 409 },
          ),
        () =>
          emptyRequest(
            { ...ctx, signal: controller.signal },
            "POST",
            "/upgrade",
          ),
      ),
    ApiError,
  );
  assert(cancelled);
  assertEquals(error.status, 409);
  assertEquals(error.method, "POST");
  assertEquals(error.path, "/upgrade");
  assertEquals(error.message, "Sprites POST /upgrade returned HTTP 409");
});

Deno.test("method preserves validated input and orders extra handles before optional resource output", async () => {
  const context = testContext(ctx.globalArgs);
  const args = z.object({
    value: z.string().transform((value) => value.length),
  });
  const output = z.object({ value: z.number(), handles: z.array(z.string()) });
  const extra = { name: "stdout" };
  const operation = method(
    "Save",
    args,
    "state",
    output,
    (input) =>
      Promise.resolve(
        withHandles({ value: input.value, handles: ["resource field"] }, [
          extra,
        ]),
      ),
  );
  const result = await operation.execute(
    args.parse({ value: "hello" }),
    context,
  );
  assertEquals(result.dataHandles.map((handle) => handle.name), [
    "stdout",
    "state",
  ]);
  assertEquals(context.getWrittenResources()[0].data, {
    value: 5,
    handles: ["resource field"],
  });

  const plain = method(
    "Plain",
    args,
    "plain",
    output,
    (input) =>
      Promise.resolve({ value: input.value, handles: ["ordinary data"] }),
  );
  assertEquals(
    (await plain.execute({ value: 5 }, context)).dataHandles.map((handle) =>
      handle.name
    ),
    ["plain"],
  );
  const bodyless = method(
    "Bodyless",
    args,
    null,
    () => Promise.resolve(),
  );
  assertEquals(await bodyless.execute({ value: 5 }, context), {
    dataHandles: [],
  });
  const artifacts = method(
    "Artifacts",
    args,
    null,
    () => Promise.resolve(withHandles(undefined, [extra])),
  );
  assertEquals(await artifacts.execute({ value: 5 }, context), {
    dataHandles: [extra],
  });
  assertEquals(context.getWrittenResources().length, 2);
});

Deno.test("deadline checks elapsed time, propagates aborts, and clears its timer on disposal", async () => {
  const short = { ...ctx, globalArgs: { ...ctx.globalArgs, timeoutMs: 10 } };
  const elapsed = deadline(short);
  const disposed = deadline(short);
  const controller = new AbortController();
  const aborted = deadline({ ...ctx, signal: controller.signal });
  try {
    assert(elapsed.remainingMs() > 0 && elapsed.remainingMs() <= 10);
    elapsed.check("too soon");
    disposed.dispose();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    assertEquals(aborted.signal.reason, reason);
    assertThrows(
      () => aborted.check("operation aborted"),
      Error,
      "operation aborted",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert(elapsed.signal.aborted);
    assertEquals(elapsed.remainingMs(), 0);
    assertThrows(
      () => elapsed.check("operation elapsed"),
      Error,
      "operation elapsed",
    );
    assert(!disposed.signal.aborted);
    assertThrows(
      () => disposed.check("elapsed without timer"),
      Error,
      "elapsed without timer",
    );
  } finally {
    elapsed.dispose();
    disposed.dispose();
    aborted.dispose();
  }
});

Deno.test("concatenate preserves binary chunks and handles empty input", () => {
  assertEquals(concatenate([]), new Uint8Array());
  assertEquals(
    concatenate([
      new Uint8Array([0, 255]),
      new Uint8Array(),
      new Uint8Array([128]),
    ]),
    new Uint8Array([0, 255, 128]),
  );
});

Deno.test("JSON calls share one wire-byte budget", async () => {
  const wire = JSON.stringify("雪");
  const size = new TextEncoder().encode(wire).length;
  const budget = { remaining: size * 2 - 1 };
  const { calls } = await withMockedFetch(
    () => new Response(wire),
    async () => {
      assertEquals(
        await jsonRequest(ctx, "GET", "/value", z.string(), { budget }),
        "雪",
      );
      assertEquals(budget.remaining, size - 1);
      await assertRejects(
        () => jsonRequest(ctx, "GET", "/value", z.string(), { budget }),
        ResponseLimitError,
        "maxResponseBytes",
      );
    },
  );
  assertEquals(calls.length, 2);
});
