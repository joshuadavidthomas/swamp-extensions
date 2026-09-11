// SPDX-License-Identifier: MIT
/** Complete single-Sprite lifecycle, execution, storage, policy, and networking model. @module */
import { SpriteArgsSchema } from "./_lib/sprite-api.ts";
import { restFiles, restMethods, restResources } from "./_lib/sprite-rest.ts";
import { execFiles, execMethods, execResources } from "./_lib/exec.ts";
import { streamingMethods, streamingResources } from "./_lib/watch-proxy.ts";
import {
  gatewayFiles,
  gatewayMethods,
  gatewayResources,
} from "./_lib/gateway.ts";
import { portMethods, portResources } from "./_lib/ports.ts";
import {
  controlFiles,
  controlMethods,
  controlResources,
} from "./_lib/control.ts";
import { managementMethods, managementResources } from "./_lib/management.ts";

/** One Sprite, scoped to one organization credential. Methods retain native API argument names. */
export const model = {
  type: "@josh/sprites/sprite",
  version: "2026.09.09.1",
  globalArguments: SpriteArgsSchema,
  resources: {
    ...restResources,
    ...execResources,
    ...streamingResources,
    ...gatewayResources,
    ...portResources,
    ...controlResources,
    ...managementResources,
  },
  files: { ...restFiles, ...execFiles, ...gatewayFiles, ...controlFiles },
  methods: {
    ...restMethods,
    ...execMethods,
    ...streamingMethods,
    ...gatewayMethods,
    ...portMethods,
    ...controlMethods,
    ...managementMethods,
  },
};
