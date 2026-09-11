// SPDX-License-Identifier: MIT
import {
  json,
  noContent,
  registerRouteCases,
  type RouteCase,
} from "./test_support.ts";

const routeCases: RouteCase[] = [
  {
    name: "getNetworkPolicy",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/policy/network",
    response: json({ rules: [{ action: "allow", domain: "example.com" }] }),
    output: "getNetworkPolicy",
  },
  {
    name: "setNetworkPolicy",
    args: { rules: [{ include: "defaults" }] },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/policy/network",
    response: noContent(),
    verifies: true,
  },
  {
    name: "getPrivilegesPolicy",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/policy/privileges",
    response: json({
      profile: "standard",
      devices: ["null"],
      noNewPrivileges: true,
    }),
    output: "getPrivilegesPolicy",
  },
  {
    name: "setPrivilegesPolicy",
    args: { noNewPrivileges: true },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/policy/privileges",
    response: noContent(),
    verifies: true,
  },
  {
    name: "deletePrivilegesPolicy",
    args: {},
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/policy/privileges",
    response: noContent(),
    verifies: true,
  },
  {
    name: "getResourcesPolicy",
    args: {},
    httpMethod: "GET",
    path: "/v1/sprites/demo%20sprite/policy/resources",
    response: json({ memory: { limit_mb: 512, autoscale: true } }),
    output: "getResourcesPolicy",
  },
  {
    name: "setResourcesPolicy",
    args: { memory: { limit_mb: 1024 } },
    httpMethod: "POST",
    path: "/v1/sprites/demo%20sprite/policy/resources",
    response: noContent(),
    verifies: true,
  },
  {
    name: "deleteResourcesPolicy",
    args: {},
    httpMethod: "DELETE",
    path: "/v1/sprites/demo%20sprite/policy/resources",
    response: noContent(),
    verifies: true,
  },
];

registerRouteCases(routeCases);
