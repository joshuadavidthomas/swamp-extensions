// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.14";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { z } from "npm:zod@4.4.3";
import { ApiError } from "./core.ts";
import { fanOut, SpriteSelector } from "./fanout.ts";
import { globalArgs, json, sprite, testContext } from "./test_support.ts";

Deno.test("SpriteSelector rejects missing and conflicting selections", () => {
  const schema = SpriteSelector;
  for (
    const select of [
      {},
      { all: true, prefix: "worker-" },
      { all: true, labels: ["ci"] },
      { prefix: "" },
      { labels: [] },
      { labels: [""] },
    ]
  ) {
    assertEquals(
      schema.safeParse(select).success,
      false,
    );
  }
  assertEquals(
    schema.safeParse({ prefix: "worker-", labels: ["ci"] }).success,
    true,
  );
});

Deno.test("fanOut saves ordered outcomes immediately and continues after sanitized failures", async () => {
  for (
    const error of [
      new ApiError(500, "POST", "/test"),
      new Error("private details"),
    ]
  ) {
    const context = testContext(globalArgs);
    const extra = z.object({
      serviceName: z.string(),
      value: z.string().optional(),
    });
    const order: string[] = [];
    const { result } = await withMockedFetch(
      [
        json({
          name: "acme",
          has_more: false,
          sprites: [1, 2, 3].map((index) => ({
            ...sprite,
            id: `id-${index}`,
            name: `worker-${index}`,
          })),
        }),
      ],
      () =>
        fanOut(
          context,
          { all: true },
          "testSpec",
          "testOp",
          extra,
          (sprite) => {
            assertEquals(context.getWrittenResources().length, order.length);
            order.push(sprite.name);
            if (sprite.name === "worker-2") return Promise.reject(error);
            return Promise.resolve({ value: sprite.name });
          },
          { serviceName: "web" },
        ),
    );
    assertEquals(order, ["worker-1", "worker-2", "worker-3"]);
    const results = [
      {
        name: "worker-1",
        id: "id-1",
        serviceName: "web",
        status: "applied",
        value: "worker-1",
      },
      {
        name: "worker-2",
        id: "id-2",
        serviceName: "web",
        status: "failed",
        error: error instanceof ApiError ? "HTTP 500" : "request failed",
      },
      {
        name: "worker-3",
        id: "id-3",
        serviceName: "web",
        status: "applied",
        value: "worker-3",
      },
    ];
    assertEquals(result.data, {
      select: { all: true },
      matched: 3,
      applied: 2,
      failed: 1,
      results,
      observedAt: result.data.observedAt,
    });
    assertEquals(typeof result.data.observedAt, "string");
    assertEquals(
      result.handles.map((handle) => handle.name),
      ["testOp-id-1", "testOp-id-2", "testOp-id-3"],
    );
    const writes = context.getWrittenResources();
    assertEquals(
      writes.map((write) => write.name),
      ["testOp-id-1", "testOp-id-2", "testOp-id-3"],
    );
    assertEquals(writes.map((write) => write.specName), [
      "testSpec",
      "testSpec",
      "testSpec",
    ]);
    assertEquals(
      writes.map((write) => write.data),
      results.map((row) => ({ ...row, observedAt: result.data.observedAt })),
    );
  }
});

Deno.test("fanOut preserves understood failure details, removes failed, and continues", async () => {
  const context = testContext(globalArgs);
  const { result } = await withMockedFetch(
    [
      json({
        name: "acme",
        has_more: false,
        sprites: [1, 2, 3].map((i) => ({
          ...sprite,
          name: `worker-${i}`,
          id: `id-${i}`,
        })),
      }),
    ],
    () =>
      fanOut(
        context,
        { all: true },
        "testSpec",
        "testOp",
        z.object({ value: z.number() }),
        (sprite) => {
          assertEquals(
            context.getWrittenResources().length,
            Number(sprite.name.slice(-1)) - 1,
          );
          return Promise.resolve(
            sprite.name === "worker-2"
              ? { failed: "understood failure", value: 17 }
              : { value: 0 },
          );
        },
      ),
  );
  const results = [
    { name: "worker-1", id: "id-1", status: "applied", value: 0 },
    {
      name: "worker-2",
      id: "id-2",
      status: "failed",
      error: "understood failure",
      value: 17,
    },
    { name: "worker-3", id: "id-3", status: "applied", value: 0 },
  ];
  assertEquals(result.data.results, results);
  assertEquals([result.data.matched, result.data.applied, result.data.failed], [
    3,
    2,
    1,
  ]);
  assertEquals(
    context.getWrittenResources().map((w) => w.data),
    results.map((row) => ({ ...row, observedAt: result.data.observedAt })),
  );
});

Deno.test("fanOut rejects repeated provider identities before running operations", async () => {
  for (
    const duplicate of [
      { ...sprite, id: "same-id", name: "worker-2" },
      { ...sprite, id: "id-2", name: "worker-1" },
    ]
  ) {
    const context = testContext(globalArgs);
    let operated = false;
    await withMockedFetch(
      [
        json({
          name: "acme",
          has_more: false,
          sprites: [
            { ...sprite, id: "same-id", name: "worker-1" },
            duplicate,
          ],
        }),
      ],
      () =>
        assertRejects(
          () =>
            fanOut(
              context,
              { all: true },
              "testSpec",
              "testOp",
              z.object({}),
              () => {
                operated = true;
                return Promise.resolve({});
              },
            ),
          Error,
          "repeated a Sprite identity",
        ),
    );
    assertEquals(operated, false);
    assertEquals(context.getWrittenResources(), []);
  }
});

Deno.test("fanOut includes operation handles before each row without storing them in outcomes", async () => {
  const context = testContext(globalArgs);
  const { result } = await withMockedFetch(
    [
      json({
        name: "acme",
        has_more: false,
        sprites: [1, 2].map((i) => ({
          ...sprite,
          name: `worker-${i}`,
          id: `id-${i}`,
        })),
      }),
    ],
    () =>
      fanOut(
        context,
        { all: true },
        "testSpec",
        "testOp",
        z.object({ value: z.number() }),
        (sprite) =>
          Promise.resolve({
            handles: [{ name: `execStdout-${sprite.id}` }, {
              name: `execStderr-${sprite.id}`,
            }],
            value: 1,
          }),
      ),
  );
  assertEquals(result.handles.map((h) => h.name), [
    "execStdout-id-1",
    "execStderr-id-1",
    "testOp-id-1",
    "execStdout-id-2",
    "execStderr-id-2",
    "testOp-id-2",
  ]);
  assertEquals(
    result.data.results,
    [1, 2].map((i) => ({
      name: `worker-${i}`,
      id: `id-${i}`,
      status: "applied",
      value: 1,
    })),
  );
  assertEquals(
    context.getWrittenResources().map((w) => w.data),
    result.data.results.map((row) => ({
      ...row,
      observedAt: result.data.observedAt,
    })),
  );
});
