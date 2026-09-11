// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  childArgs,
  json,
  ndjson,
  sprite,
  testContext,
} from "./_lib/test_support.ts";
import { model } from "./checkpoint.ts";

const globalArgs = { ...childArgs, name: "golden" };
const parent = { name: sprite.name, id: sprite.id };
const checkpoint = {
  id: "v/1",
  create_time: "2026-01-02T00:00:00Z",
  comment: "safe",
};
const checkpointStream =
  '{"type":"info","data":"working","time":"2026-01-02T00:00:00Z"}\n' +
  '{"type":"complete","data":"done","time":"2026-01-02T00:00:01Z"}\n';

Deno.test("checkpoint create binds the newest by time, including when retaking a bound slot", async () => {
  for (const bound of [false, true]) {
    const test = testContext(globalArgs, {
      storedResources: bound
        ? { state: { ...checkpoint, id: "old", sprite: parent } }
        : {},
    });
    let body: unknown;
    const { result, calls } = await withMockedFetch(async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/checkpoint")) {
        body = await req.json();
        return ndjson(checkpointStream);
      }
      if (url.pathname.endsWith("/checkpoints")) {
        return json([
          { ...checkpoint, id: "older", create_time: "2026-01-01T00:00:00Z" },
          checkpoint,
          { ...checkpoint, id: "oldest", create_time: "2025-12-31T00:00:00Z" },
        ]);
      }
      return json(sprite);
    }, () => model.methods.create.execute({ comment: "safe" }, test));
    assertEquals(calls.map((c) => c.method), ["GET", "POST", "GET"]);
    assertEquals(
      calls[0].url,
      "https://api.sprites.dev/v1/sprites/demo%20sprite",
    );
    assertEquals(
      calls[1].url,
      "https://api.sprites.dev/v1/sprites/demo%20sprite/checkpoint",
    );
    assertEquals(
      calls[2].url,
      "https://api.sprites.dev/v1/sprites/demo%20sprite/checkpoints",
    );
    assertEquals(calls[1].headers.authorization, "Bearer test-token");
    assertEquals(body, { comment: "safe" });
    assertEquals(result.dataHandles.length, 2);
    assertEquals(test.getWrittenResources().map((w) => w.specName), [
      "create",
      "state",
    ]);
    assertEquals(test.getWrittenResources()[1].data, {
      ...checkpoint,
      sprite: parent,
    });
  }
});
Deno.test("checkpoint get, restore and lookup use the saved or adopted id", async () => {
  for (const name of ["get", "restore", "lookup"] as const) {
    const test = testContext(globalArgs, {
      storedResources: name === "lookup"
        ? {}
        : { state: { ...checkpoint, sprite: parent } },
    });
    const { calls } = await withMockedFetch(
      [
        json(sprite),
        name === "restore" ? ndjson(checkpointStream) : json(checkpoint),
      ],
      () =>
        model.methods[name].execute(
          (name === "lookup" ? { checkpoint_id: checkpoint.id } : {}) as never,
          test,
        ),
    );
    assertEquals(
      calls[0].url,
      "https://api.sprites.dev/v1/sprites/demo%20sprite",
    );
    assertEquals(calls[0].method, "GET");
    assertEquals(calls[1].method, name === "restore" ? "POST" : "GET");
    assertEquals(
      calls[1].url,
      "https://api.sprites.dev/v1/sprites/demo%20sprite/checkpoints/v%2F1" +
        (name === "restore" ? "/restore" : ""),
    );
    assertEquals(calls[1].headers.authorization, "Bearer test-token");
    assertEquals(
      test.getWrittenResources()[0].specName,
      name === "restore" ? "restore" : "state",
    );
    if (name !== "restore") {
      assertEquals(test.getWrittenResources()[0].data, {
        ...checkpoint,
        sprite: parent,
      });
    }
  }
});
Deno.test("checkpoint refuses unbound non-binding methods and all methods on a replaced Sprite", async () => {
  for (const name of ["get", "restore", "create", "lookup"] as const) {
    for (const bound of [false, true]) {
      if (!bound && (name === "create" || name === "lookup")) continue;
      const test = testContext(globalArgs, {
        storedResources: bound
          ? { state: { ...checkpoint, sprite: parent } }
          : {},
      });
      const { calls } = await withMockedFetch(
        bound ? [json({ ...sprite, id: "replacement" })] : [],
        () =>
          assertRejects(
            () =>
              model.methods[name].execute(
                model.methods[name].arguments.parse({
                  checkpoint_id: checkpoint.id,
                }) as never,
                test,
              ),
            Error,
            bound ? "replaced" : "No Sprite identity is saved",
          ),
      );
      assertEquals(calls.length, bound ? 1 : 0);
      assertEquals(test.getWrittenResources(), []);
    }
  }
});
Deno.test("checkpoint NDJSON rejects provider errors, malformed events, and incomplete streams", async () => {
  for (
    const body of [
      '{"type":"error","error":"disk full","time":"2026-01-02T00:00:00Z"}\n',
      '{"type":"info","data":"working","time":"2026-01-02T00:00:00Z"}\n',
      "{broken}\n",
    ]
  ) {
    const test = testContext(globalArgs);
    await withMockedFetch(
      [json(sprite), ndjson(body)],
      () => assertRejects(() => model.methods.create.execute({}, test), Error),
    );
    assertEquals(test.getWrittenResources(), []);
  }
});
Deno.test("checkpoint creation refuses an empty checkpoint list after completion", async () => {
  const test = testContext(globalArgs);
  await withMockedFetch(
    [json(sprite), ndjson(checkpointStream), json([])],
    () =>
      assertRejects(
        () => model.methods.create.execute({}, test),
        Error,
        "no checkpoint was listed",
      ),
  );
  assertEquals(test.getWrittenResources(), []);
});
