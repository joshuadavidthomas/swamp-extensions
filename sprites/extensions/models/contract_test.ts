// SPDX-License-Identifier: MIT
import { assertEquals } from "jsr:@std/assert@1.0.14";
import { z } from "npm:zod@4.4.3";
import { model as checkpoint } from "./checkpoint.ts";
import { model as connector } from "./connector.ts";
import { model as organization } from "./organization.ts";
import { model as service } from "./service.ts";
import { model as sprite } from "./sprite.ts";
import { model as task } from "./task.ts";

type Fields = Record<string, boolean>;
type PublicModel = {
  globalArguments: z.ZodObject;
  methods: Record<string, { arguments: z.ZodObject }>;
};

function fields(schema: z.ZodObject): Fields {
  return Object.fromEntries(
    Object.entries(schema.shape).map(([name, field]) => [
      name,
      !(field as z.ZodType).safeParse(undefined).success,
    ]),
  );
}

const globals = {
  checkpoint: {
    token: true,
    baseUrl: false,
    timeoutMs: false,
    maxResponseBytes: false,
    sprite: true,
    name: true,
  },
  connector: {
    token: true,
    baseUrl: false,
    timeoutMs: false,
    maxResponseBytes: false,
    name: true,
    provider: true,
  },
  organization: {
    token: true,
    baseUrl: false,
    timeoutMs: false,
    maxResponseBytes: false,
  },
  service: {
    token: true,
    baseUrl: false,
    timeoutMs: false,
    maxResponseBytes: false,
    sprite: true,
    service_name: true,
  },
  sprite: {
    token: true,
    baseUrl: false,
    timeoutMs: false,
    maxResponseBytes: false,
    name: true,
  },
  task: {
    token: true,
    baseUrl: false,
    timeoutMs: false,
    maxResponseBytes: false,
    sprite: true,
    name: true,
  },
} satisfies Record<string, Fields>;

const methods = {
  checkpoint: {
    create: { comment: false },
    get: {},
    restore: {},
    lookup: { checkpoint_id: true },
  },
  connector: {
    createApiKey: { api_key: true, access_policy: false },
    provision: {},
    authorize: {
      scopes: false,
      add_scopes: false,
      redirect_uri: false,
      state: false,
    },
    callback: { code: true, redirect_uri: false, access_policy: false },
    get: {},
    updatePolicy: { access_policy: true },
    delete: {},
    lookup: { id: true },
  },
  organization: {
    exec: {
      cmd: true,
      path: false,
      dir: false,
      env: false,
      input: false,
      select: true,
    },
    listSprites: { prefix: false },
    setNetworkPolicy: { select: true, policy: true },
    setPrivilegesPolicy: { select: true, policy: true },
    setResourcesPolicy: { select: true, policy: true },
    deletePrivilegesPolicy: { select: true },
    deleteResourcesPolicy: { select: true },
    getNetworkPolicy: { select: true },
    getPrivilegesPolicy: { select: true },
    getResourcesPolicy: { select: true },
    upgrade: { select: true, version: false },
    restart: { select: true },
    createCheckpoint: { select: true, comment: false },
    putService: {
      select: true,
      service_name: true,
      service: true,
      duration: false,
    },
    startService: { select: true, service_name: true, duration: false },
    stopService: { select: true, service_name: true, timeout: false },
    restartService: { select: true, service_name: true, duration: false },
    deleteService: { select: true, service_name: true },
    listConnectors: { provider: false },
  },
  service: {
    put: { service: true, duration: false },
    get: {},
    start: { duration: false },
    stop: { timeout: false },
    restart: { duration: false },
    logs: { lines: false, duration: false },
    signal: { signal: true },
    delete: {},
  },
  sprite: {
    create: {
      config: false,
      environment: false,
      url_settings: false,
      labels: false,
      wait_for_capacity: false,
      runtime: false,
    },
    lookup: {},
    update: { url_settings: false, labels: false },
    upgrade: { version: false },
    restart: {},
    probeUrl: {},
    delete: {},
    listCheckpoints: {},
    controlExec: { operations: true },
    exec: {
      cmd: true,
      path: false,
      dir: false,
      env: false,
      input: false,
      failOnNonZero: false,
      tty: false,
      rows: false,
      cols: false,
      detachable: false,
      cc: false,
      max_run_after_disconnect: false,
      closeStdin: false,
      actions: false,
      detachAfterMs: false,
    },
    attach: {
      session_id: true,
      input: false,
      failOnNonZero: false,
      tty: false,
      rows: false,
      cols: false,
      detachable: false,
      cc: false,
      max_run_after_disconnect: false,
      closeStdin: false,
      actions: false,
      detachAfterMs: false,
    },
    execHttp: {
      cmd: true,
      path: false,
      dir: false,
      env: false,
      input: false,
      failOnNonZero: false,
    },
    listSessions: {},
    killSession: { session_id: true, signal: false, timeout: false },
    listFiles: {
      workingDir: false,
      path: true,
      recursive: false,
      pattern: false,
    },
    readFile: { workingDir: false, path: true },
    writeFile: {
      workingDir: false,
      path: true,
      content: true,
      mode: false,
      mkdir: false,
    },
    deleteFile: {
      workingDir: false,
      path: true,
      recursive: false,
      asRoot: false,
    },
    copyFile: {
      source: true,
      dest: true,
      preserveAttrs: false,
      workingDir: false,
      recursive: false,
      asRoot: false,
    },
    renameFile: {
      source: true,
      dest: true,
      workingDir: false,
      asRoot: false,
    },
    chmodFile: {
      workingDir: false,
      path: true,
      recursive: false,
      asRoot: false,
      mode: true,
    },
    chownFile: {
      workingDir: false,
      path: true,
      recursive: false,
      asRoot: false,
      uid: false,
      gid: false,
    },
    watch: {
      paths: true,
      recursive: false,
      workingDir: false,
      durationMs: true,
      maxEvents: false,
    },
    getNetworkPolicy: {},
    setNetworkPolicy: { rules: true },
    getPrivilegesPolicy: {},
    setPrivilegesPolicy: {
      profile: false,
      devices: false,
      noNewPrivileges: false,
    },
    deletePrivilegesPolicy: {},
    getResourcesPolicy: {},
    setResourcesPolicy: { memory: false },
    deleteResourcesPolicy: {},
    watchPorts: { durationMs: true, maxEvents: false },
    proxy: {
      localPort: true,
      host: true,
      port: true,
      durationMs: true,
      maxConnections: false,
    },
    listServices: {},
    listTasks: {},
    gatewayList: {},
    gatewayRequest: {
      provider: true,
      connection_id: true,
      providerPath: true,
      method: true,
      headers: false,
      input: false,
    },
  },
  task: {
    create: { expire: true },
    get: {},
    refresh: { expire: true },
    delete: {},
  },
} satisfies Record<string, Record<string, Fields>>;

const models = { checkpoint, connector, organization, service, sprite, task };

Deno.test("published model argument contracts are exact", () => {
  for (const [name, untypedModel] of Object.entries(models)) {
    const model = untypedModel as unknown as PublicModel;
    assertEquals(
      fields(model.globalArguments),
      globals[name as keyof typeof globals],
      `${name} globals`,
    );
    assertEquals(
      Object.keys(model.methods),
      Object.keys(methods[name as keyof typeof methods]),
      `${name} methods`,
    );
    for (
      const [methodName, expected] of Object.entries(
        methods[name as keyof typeof methods],
      )
    ) {
      assertEquals(
        fields(model.methods[methodName].arguments),
        expected,
        `${name}.${methodName} arguments`,
      );
    }
  }
});
