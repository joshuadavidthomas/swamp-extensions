// SPDX-License-Identifier: MIT
/** Sprite network, privilege, and resource policy routes. @module */
import { z } from "zod";
import { Empty, emptyRequest, jsonRequest, method, resource } from "./core.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite.ts";

const NetworkRule = z.object({
  domain: z.string().optional(),
  action: z.enum(["allow", "deny"]).optional(),
  include: z.string().optional(),
}).refine(
  (rule) => !(rule.domain !== undefined && rule.include !== undefined),
  {
    message: "A network rule cannot contain both domain and include.",
  },
);
export const NetworkPolicy = z.object({ rules: z.array(NetworkRule) });
export const PrivilegesPolicy = z.object({
  profile: z.enum(["", "minimal", "standard", "privileged"]).optional(),
  devices: z.array(z.string()).optional(),
  noNewPrivileges: z.boolean().optional(),
});
export const ResourcesPolicy = z.object({
  memory: z.object({
    limit_mb: z.number().positive(),
    autoscale: z.boolean().optional(),
  }).optional(),
});

export const policyResources = {
  getNetworkPolicy: resource(NetworkPolicy, "Sprite network policy"),
  getPrivilegesPolicy: resource(PrivilegesPolicy, "Sprite privilege policy"),
  getResourcesPolicy: resource(ResourcesPolicy, "Sprite resource policy"),
};

export const policyMethods = {
  getNetworkPolicy: method(
    "Read the Sprite network policy",
    Empty,
    "getNetworkPolicy",
    NetworkPolicy,
    (_args, ctx: SpriteContext) =>
      jsonRequest(
        ctx,
        "GET",
        spritePath(ctx.globalArgs.name, "/policy/network"),
        NetworkPolicy,
      ),
  ),
  setNetworkPolicy: method(
    "Replace the Sprite network policy",
    NetworkPolicy,
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "POST",
        spritePath(ctx.globalArgs.name, "/policy/network"),
        {
          json: args,
        },
      );
    },
  ),
  getPrivilegesPolicy: method(
    "Read the Sprite privilege policy",
    Empty,
    "getPrivilegesPolicy",
    PrivilegesPolicy,
    (_args, ctx: SpriteContext) =>
      jsonRequest(
        ctx,
        "GET",
        spritePath(ctx.globalArgs.name, "/policy/privileges"),
        PrivilegesPolicy,
      ),
  ),
  setPrivilegesPolicy: method(
    "Set the Sprite privilege policy",
    PrivilegesPolicy,
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "POST",
        spritePath(ctx.globalArgs.name, "/policy/privileges"),
        {
          json: args,
        },
      );
    },
  ),
  deletePrivilegesPolicy: method(
    "Remove the Sprite privilege policy",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "DELETE",
        spritePath(ctx.globalArgs.name, "/policy/privileges"),
      );
    },
  ),
  getResourcesPolicy: method(
    "Read the Sprite resource policy",
    Empty,
    "getResourcesPolicy",
    ResourcesPolicy,
    (_args, ctx: SpriteContext) =>
      jsonRequest(
        ctx,
        "GET",
        spritePath(ctx.globalArgs.name, "/policy/resources"),
        ResourcesPolicy,
      ),
  ),
  setResourcesPolicy: method(
    "Set the Sprite resource policy",
    ResourcesPolicy,
    null,
    async (args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "POST",
        spritePath(ctx.globalArgs.name, "/policy/resources"),
        {
          json: args,
        },
      );
    },
  ),
  deleteResourcesPolicy: method(
    "Remove the Sprite resource policy",
    Empty,
    null,
    async (_args, ctx: SpriteContext) => {
      await verifySprite(ctx);
      await emptyRequest(
        ctx,
        "DELETE",
        spritePath(ctx.globalArgs.name, "/policy/resources"),
      );
    },
  ),
};
