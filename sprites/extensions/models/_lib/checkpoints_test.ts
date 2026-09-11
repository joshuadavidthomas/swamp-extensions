// SPDX-License-Identifier: MIT
import { json, registerRouteCases } from "./test_support.ts";
const checkpoint = {
  id: "v1",
  create_time: "2026-01-02T00:00:00Z",
  comment: "safe",
};

registerRouteCases([{
  name: "listCheckpoints",
  args: {},
  httpMethod: "GET",
  path: "/v1/sprites/demo%20sprite/checkpoints",
  response: json([checkpoint]),
  output: "checkpoints",
}]);
