// SPDX-License-Identifier: MIT
import { assertRejects, assertStringIncludes } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  globalArgs,
  json,
  ndjson,
  registerRouteCases,
  type RouteCase,
  runnable,
  sprite,
  testContext,
} from "./test_support.ts";

const checkpoint = {
  id: "v1",
  create_time: "2026-01-02T00:00:00Z",
  comment: "safe",
};
const checkpointStream =
  '{"type":"info","data":"working","time":"2026-01-02T00:00:00Z"}\n' +
  '{"type":"complete","data":"done","time":"2026-01-02T00:00:01Z"}\n';

const routeCases: RouteCase[] = [
  {
    name: "createCheckpoint",
    args: { comment: "safe" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/checkpoint",
    response: ndjson(checkpointStream),
    verifies: true,
    output: "checkpointCreated",
  },
  {
    name: "listCheckpoints",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/checkpoints",
    response: json([checkpoint]),
    output: "checkpoints",
  },
  {
    name: "getCheckpoint",
    args: { checkpoint_id: "v/1" },
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/checkpoints/v%2F1",
    response: json(checkpoint),
    output: "checkpoint",
  },
  {
    name: "restoreCheckpoint",
    args: { checkpoint_id: "v/1" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/checkpoints/v%2F1/restore",
    response: ndjson(checkpointStream),
    verifies: true,
    output: "checkpointRestored",
  },
];

registerRouteCases(routeCases);

Deno.test("NDJSON rejects provider errors, malformed events, and incomplete streams", async () => {
  for (
    const body of [
      '{"type":"error","error":"disk full","time":"2026-01-02T00:00:00Z"}\n',
      '{"type":"info","data":"working","time":"2026-01-02T00:00:00Z"}\n',
      "{broken}\n",
    ]
  ) {
    const context = testContext(globalArgs, {
      storedResources: { state: sprite },
    });
    await assertRejects(
      () =>
        withMockedFetch(
          [json(sprite), ndjson(body)],
          () =>
            runnable("createCheckpoint").execute(
              {},
              { ...context, globalArgs },
            ),
        ),
      Error,
    );
  }

  const context = testContext(globalArgs);
  const error = await assertRejects(
    () =>
      withMockedFetch(
        [ndjson('{"type":"stdout","data":"still running","timestamp":1}\n')],
        () =>
          runnable("getServiceLogs").execute(
            { service_name: "web/API" },
            { ...context, globalArgs },
          ),
      ),
    Error,
  );
  assertStringIncludes(error.message, "without a complete event");
});
