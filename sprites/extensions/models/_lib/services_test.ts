// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import {
  globalArgs,
  json,
  ndjson,
  noContent,
  registerRouteCases,
  type RouteCase,
  runnable,
  sprite,
  testContext,
} from "./test_support.ts";

const service = {
  name: "web/API",
  cmd: "node",
  args: ["server.js"],
  env: { SECRET: "value" },
  dir: "/app",
  needs: [],
  http_port: 8080,
  state: {
    name: "web/API",
    status: "running",
    pid: 42,
    started_at: "2026-01-02T00:00:00Z",
    restart_count: 2,
    next_restart_at: "2026-01-03T00:00:00Z",
  },
};
const serviceStream = '{"type":"stdout","data":"ready\\n","timestamp":1}\n' +
  '{"type":"complete","timestamp":2,"log_files":{"stdout":"/.sprite/logs/web.log"}}\n';

const routeCases: RouteCase[] = [
  {
    name: "listServices",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/services",
    response: json([service]),
    output: "services",
  },
  {
    name: "putService",
    args: {
      service_name: "web/API",
      duration: "5s",
      service: { cmd: "node", args: ["server.js"], needs: [] },
    },
    httpMethod: "PUT",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "servicePut",
  },
  {
    name: "getServiceLogs",
    args: { service_name: "web/API", lines: 50, duration: "2s" },
    httpMethod: "GET",
    path:
      "/v1/sprites/demo%20sprite/services/web%2FAPI/logs?lines=50&duration=2s",
    response: ndjson(serviceStream),
    output: "serviceLogs",
  },
  {
    name: "startService",
    args: { service_name: "web/API", duration: "5s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/start?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "serviceStarted",
  },
  {
    name: "stopService",
    args: { service_name: "web/API", timeout: "10s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/stop?timeout=10s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "serviceStopped",
  },
  {
    name: "restartService",
    args: { service_name: "web/API", duration: "5s" },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI/restart?duration=5s",
    response: ndjson(serviceStream),
    verifies: true,
    output: "serviceRestarted",
  },
  {
    name: "deleteService",
    args: { service_name: "web/API" },
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/services/web%2FAPI",
    response: noContent(),
    verifies: true,
  },
];

registerRouteCases(routeCases);

Deno.test("startup exits fail even with complete, while stop and log exits remain data", async () => {
  for (
    const name of ["putService", "startService", "restartService"] as const
  ) {
    for (const code of [0, 1, 137]) {
      for (const complete of ["", '{"type":"complete","timestamp":3}\n']) {
        const test = testContext(globalArgs, {
          storedResources: { state: sprite },
        });
        const events =
          `{"type":"started","timestamp":1}\n{"type":"exit","exit_code":${code},"timestamp":2}\n${complete}`;
        await assertRejects(
          () =>
            withMockedFetch(
              [json(sprite), ndjson(events)],
              () =>
                runnable(name).execute(
                  { service_name: service.name, service },
                  test,
                ),
            ),
          Error,
          `exited during startup with code ${code}`,
        );
      }
    }
  }
  for (
    const name of ["stopService", "getServiceLogs", "restartService"] as const
  ) {
    const test = testContext(globalArgs, {
      storedResources: { state: sprite },
    });
    const event = name === "getServiceLogs" ? "exit" : "stopped";
    const events = `{"type":"${event}","exit_code":143,"timestamp":1}\n` +
      (name === "restartService" ? '{"type":"started","timestamp":2}\n' : "") +
      '{"type":"complete","timestamp":3}\n';
    await withMockedFetch(
      [...(name === "getServiceLogs" ? [] : [json(sprite)]), ndjson(events)],
      () => runnable(name).execute({ service_name: service.name }, test),
    );
    assertEquals(test.getWrittenResources().length, 1);
  }
});
