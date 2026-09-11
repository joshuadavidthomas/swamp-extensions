// SPDX-License-Identifier: MIT
import { json, registerRouteCases } from "./test_support.ts";

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

registerRouteCases([
  {
    name: "listServices",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/services",
    response: json([service]),
    output: "services",
  },
]);
