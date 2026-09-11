// SPDX-License-Identifier: MIT
/** Sprite network, privilege, and resource policy schemas. @module */
import { z } from "npm:zod@4.4.3";

export const NetworkRule = z.object({
  domain: z.string().optional(),
  action: z.enum(["allow", "deny"]).optional(),
  include: z.string().optional(),
}).refine(
  (rule) => !(rule.domain !== undefined && rule.include !== undefined),
  { message: "A network rule cannot contain both domain and include." },
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
