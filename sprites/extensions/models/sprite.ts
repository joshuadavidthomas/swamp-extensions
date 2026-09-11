// SPDX-License-Identifier: MIT
/** Complete single-Sprite lifecycle, execution, storage, policy, and networking model. @module */
import {
  SpriteArgsSchema,
  spriteMethods,
  spriteResources,
} from "./_lib/sprite.ts";
import {
  checkpointsMethods,
  checkpointsResources,
} from "./_lib/checkpoints.ts";
import {
  controlFiles,
  controlMethods,
  controlResources,
} from "./_lib/control.ts";
import { execFiles, execMethods, execResources } from "./_lib/exec.ts";
import { fsFiles, fsMethods, fsResources } from "./_lib/fs.ts";
import { policyMethods, policyResources } from "./_lib/policy.ts";
import { portsMethods, portsResources } from "./_lib/ports.ts";
import { proxyMethods, proxyResources } from "./_lib/proxy.ts";
import { servicesMethods, servicesResources } from "./_lib/services.ts";
import { localApiMethods, localApiResources } from "./_lib/local-api.ts";
import {
  gatewayFiles,
  gatewayMethods,
  gatewayResources,
} from "./_lib/gateway.ts";

/** One Sprite, scoped to one organization credential. Methods retain native API argument names. */
export const model = {
  type: "@josh/sprites/sprite",
  version: "2026.09.10.1",
  globalArguments: SpriteArgsSchema,
  resources: {
    ...spriteResources,
    ...checkpointsResources,
    ...controlResources,
    ...execResources,
    ...fsResources,
    ...policyResources,
    ...portsResources,
    ...proxyResources,
    ...servicesResources,
    ...localApiResources,
    ...gatewayResources,
  },
  files: {
    ...controlFiles,
    ...execFiles,
    ...fsFiles,
    ...gatewayFiles,
  },
  methods: {
    ...spriteMethods,
    ...checkpointsMethods,
    ...controlMethods,
    ...execMethods,
    ...fsMethods,
    ...policyMethods,
    ...portsMethods,
    ...proxyMethods,
    ...servicesMethods,
    ...localApiMethods,
    ...gatewayMethods,
  },
};
