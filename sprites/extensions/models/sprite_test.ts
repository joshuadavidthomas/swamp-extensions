// SPDX-License-Identifier: MIT
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.14";
import { withMockedFetch } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { testContext } from "./_lib/test_support.ts";
import { model } from "./sprite.ts";
import { type SpriteContext, spritePath } from "./_lib/sprite.ts";

const globals = model.globalArguments.parse({
  name: "worker",
  token: "test-token",
});
const replacement = {
  id: "new-id",
  name: "worker",
  organization: "acme",
  url_settings: { auth: "sprite", private_access: "org_users" },
  url: "https://example.com",
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
Deno.test("Sprite names reject dot segments and uploads reject host filesystem paths", () => {
  for (const name of [".", ".."]) {
    assertThrows(
      () => spritePath(name),
      Error,
      "dot segment",
    );
  }
  const file = { kind: "file", path: "/etc/passwd" };
  assertEquals(
    model.methods.exec.arguments.safeParse({ cmd: ["cat"], input: file })
      .success,
    false,
  );
  assertEquals(
    model.methods.writeFile.arguments.safeParse({
      path: "/upload",
      content: file,
    }).success,
    false,
  );
  assertEquals(
    model.methods.gatewayRequest.arguments.safeParse({
      provider: "github",
      connection_id: "c1",
      providerPath: "/user",
      method: "POST",
      input: file,
    }).success,
    false,
  );
});

Deno.test("sessions use the provider object envelope and ownership requires numeric IDs", async () => {
  const test = testContext(globals);
  await withMockedFetch(
    [new Response('{"sessions":[]}')],
    () => model.methods.listSessions.execute({}, test),
  );
  assertEquals(test.getWrittenResources()[0].data, {
    sessions: [],
  });
  assertEquals(
    model.methods.chownFile.arguments.safeParse({
      path: "/tmp/file",
      uid: "sprite",
    }).success,
    false,
  );
  assertEquals(
    model.methods.chownFile.arguments.safeParse({
      path: "/tmp/file",
      uid: 1000,
    }).success,
    true,
  );
});

Deno.test("nonempty session envelopes preserve the typed session fields", async () => {
  const test = testContext(globals);
  const session = {
    id: 7,
    command: "/bin/sleep 10",
    workdir: "/home/sprite",
    created: "2026-09-10T06:00:00Z",
    bytes_per_second: 0,
    is_active: true,
    tty: false,
  };
  await withMockedFetch(
    [new Response(JSON.stringify({ sessions: [session] }))],
    () => model.methods.listSessions.execute({}, test),
  );
  assertEquals(test.getWrittenResources()[0].data, {
    sessions: [session],
  });
});

Deno.test("mutations require a saved identity before adopting an existing Sprite", async () => {
  const test = testContext(globals);
  const { calls } = await withMockedFetch(
    [new Response(JSON.stringify(replacement))],
    () =>
      assertRejects(
        () => model.methods.delete.execute({}, test),
        Error,
        "No Sprite identity is saved",
      ),
  );
  assertEquals(calls.length, 0);
  assertEquals(test.getWrittenResources(), []);
});

Deno.test("execution, attachment, and gateway methods refuse a replaced Sprite", async () => {
  const cases = [
    { name: "exec", args: { cmd: ["echo", "hello"] } },
    { name: "execHttp", args: { cmd: ["echo", "hello"] } },
    { name: "attach", args: { session_id: "7" } },
    { name: "gatewayList", args: {} },
    {
      name: "gatewayRequest",
      args: {
        provider: "github",
        connection_id: "conn1",
        providerPath: "/user",
        method: "POST",
      },
    },
  ] as const;
  for (const item of cases) {
    const test = testContext(globals, {
      storedResources: { state: { ...replacement, id: "old-id" } },
    });
    const selected = model.methods[item.name] as unknown as {
      execute(args: unknown, ctx: SpriteContext): Promise<unknown>;
    };
    const { calls } = await withMockedFetch(
      [new Response(JSON.stringify(replacement))],
      () =>
        assertRejects(
          () => selected.execute(item.args, test),
          Error,
          "replaced",
        ),
    );
    assertEquals(calls.length, 1, item.name);
    assertEquals(calls[0].method, "GET");
    assertEquals(test.getWrittenResources(), []);
    assertEquals(test.getWrittenFiles(), []);
  }
});

Deno.test("public control and exec methods dispatch collaborators and order file handles before resources", async () => {
  const calls: string[] = [];
  const socketResult = {
    stdout: new Uint8Array([1, 2]),
    stderr: new Uint8Array([3]),
    exitCode: 0,
    sessionId: "session-1",
    controls: [],
    status: "exited" as const,
  };
  const cases = [
    {
      name: "controlExec",
      args: { operations: [{ cmd: ["true"] }] },
      dependencies: {
        controlExec: () => {
          calls.push("controlExec");
          return Promise.resolve({
            stdout: new Uint8Array([1]),
            stderr: new Uint8Array([2]),
            exitCode: 0,
            operations: [{
              operation: 1,
              exitCode: 0,
              tty: false,
              stdoutOffset: 0,
              stdoutLength: 1,
              stderrOffset: 0,
              stderrLength: 1,
            }],
          });
        },
      },
      handles: ["controlExecStdout", "controlExecStderr", "controlExec"],
    },
    {
      name: "exec",
      args: { cmd: ["printf", "test"] },
      dependencies: {
        socketExec: (_ctx: unknown, args: object) => {
          calls.push("session_id" in args ? "attach" : "exec");
          return Promise.resolve(socketResult);
        },
      },
      handles: ["execStdout", "execStderr", "exec"],
    },
    {
      name: "attach",
      args: { session_id: "session-1" },
      dependencies: {
        socketExec: (_ctx: unknown, args: object) => {
          calls.push("session_id" in args ? "attach" : "exec");
          return Promise.resolve(socketResult);
        },
      },
      handles: ["attachStdout", "attachStderr", "attach"],
    },
    {
      name: "execHttp",
      args: { cmd: ["printf", "test"] },
      dependencies: {
        managementExec: () => {
          calls.push("execHttp");
          return Promise.resolve({
            stdout: socketResult.stdout,
            stderr: socketResult.stderr,
            exitCode: 0,
          });
        },
      },
      handles: ["execHttpStdout", "execHttpStderr", "execHttp"],
    },
  ] as const;

  for (const item of cases) {
    const context = Object.assign(
      testContext(globals, { storedResources: { state: replacement } }),
      item.dependencies,
    );
    const method = model.methods[item.name] as unknown as {
      arguments: { parse(value: unknown): unknown };
      execute(
        args: unknown,
        ctx: SpriteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }>;
    };
    const { result } = await withMockedFetch(
      [new Response(JSON.stringify(replacement))],
      () => method.execute(method.arguments.parse(item.args), context),
    );
    assertEquals(calls.at(-1), item.name, item.name);
    assertEquals(
      result.dataHandles.map((handle) => handle.name),
      [...item.handles],
      item.name,
    );
    assertEquals(
      context.getWrittenResources()[0].specName,
      item.name,
      item.name,
    );
  }
});

Deno.test("public watch, port-watch, and proxy methods dispatch and save their resource specs", async () => {
  const calls: string[] = [];
  const cases = [
    {
      name: "watch",
      args: { paths: ["/tmp"], durationMs: 1 },
      dependencies: {
        watch: () => {
          calls.push("watch");
          return Promise.resolve({
            events: [{ type: "event" as const, path: "/tmp/file" }],
            truncated: true as const,
          });
        },
      },
    },
    {
      name: "watchPorts",
      args: { durationMs: 1 },
      dependencies: {
        portWatch: () => {
          calls.push("watchPorts");
          return Promise.resolve({
            initialPorts: [],
            notifications: [],
            truncated: true as const,
          });
        },
      },
    },
    {
      name: "proxy",
      args: {
        localPort: 3000,
        host: "db.internal",
        port: 5432,
        durationMs: 1,
      },
      dependencies: {
        proxy: () => {
          calls.push("proxy");
          return Promise.resolve({
            localAddress: "127.0.0.1" as const,
            localPort: 3000,
            remoteHost: "db.internal",
            remotePort: 5432,
            acceptedConnections: 1,
            completedConnections: 1,
            rejectedConnections: 0,
            bytesFromClients: 4,
            bytesFromRemote: 5,
            durationMs: 1,
            closed: true as const,
          });
        },
      },
    },
  ] as const;

  for (const item of cases) {
    const context = Object.assign(testContext(globals), item.dependencies);
    const method = model.methods[item.name] as unknown as {
      arguments: { parse(value: unknown): unknown };
      execute(args: unknown, ctx: SpriteContext): Promise<unknown>;
    };
    await method.execute(method.arguments.parse(item.args), context);
    assertEquals(calls.at(-1), item.name, item.name);
    assertEquals(
      context.getWrittenResources()[0].specName,
      item.name,
      item.name,
    );
  }
});

Deno.test("public kill and gateway methods dispatch and preserve output handle order", async () => {
  const kill = testContext(globals, {
    storedResources: { state: replacement },
  });
  const killResult = await withMockedFetch(
    [
      new Response(JSON.stringify(replacement)),
      new Response('{"type":"complete"}\n'),
    ],
    () =>
      model.methods.killSession.execute(
        model.methods.killSession.arguments.parse({ session_id: "session/1" }),
        kill,
      ),
  );
  assertEquals(
    killResult.result.dataHandles.map((handle) => handle.name),
    ["killSession"],
  );
  assertEquals(kill.getWrittenResources()[0].specName, "killSession");

  const calls: string[] = [];
  const gatewayList = Object.assign(
    testContext(globals, { storedResources: { state: replacement } }),
    {
      gatewayDiscover: () => {
        calls.push("gatewayList");
        return Promise.resolve({ connections: [], available: [] });
      },
    },
  );
  const listResult = await withMockedFetch(
    [new Response(JSON.stringify(replacement))],
    () => model.methods.gatewayList.execute({}, gatewayList),
  );
  assertEquals(calls.at(-1), "gatewayList");
  assertEquals(
    listResult.result.dataHandles.map((handle) => handle.name),
    ["gatewayList"],
  );

  const gatewayRequest = Object.assign(
    testContext(globals, { storedResources: { state: replacement } }),
    {
      gatewayRelay: (_ctx: unknown, args: { providerPath: string }) => {
        calls.push(`gatewayRequest:${args.providerPath}`);
        return Promise.resolve({
          status: 200,
          statusText: "OK",
          headers: { "content-type": ["application/octet-stream"] },
          bodyBytes: 2,
          body: new Uint8Array([4, 5]),
        });
      },
    },
  );
  const requestResult = await withMockedFetch(
    [new Response(JSON.stringify(replacement))],
    () =>
      model.methods.gatewayRequest.execute(
        model.methods.gatewayRequest.arguments.parse({
          provider: "github",
          connection_id: "connection-1",
          providerPath: "/user",
          method: "GET",
        }),
        gatewayRequest,
      ),
  );
  assertEquals(calls.at(-1), "gatewayRequest:/user");
  assertEquals(
    requestResult.result.dataHandles.map((handle) => handle.name),
    ["gatewayRequestBody", "gatewayRequest"],
  );
  assertEquals(
    gatewayRequest.getWrittenFiles()[0].specName,
    "gatewayRequestBody",
  );
  assertEquals(
    gatewayRequest.getWrittenResources()[0].specName,
    "gatewayRequest",
  );
});

Deno.test("Sprite assembly exposes exactly its lifecycle, routes, and collection reads", () => {
  assertEquals(
    Object.keys(model.methods).sort(),
    [
      "create",
      "lookup",
      "update",
      "upgrade",
      "restart",
      "probeUrl",
      "delete",
      "listFiles",
      "readFile",
      "writeFile",
      "deleteFile",
      "copyFile",
      "renameFile",
      "chmodFile",
      "chownFile",
      "watch",
      "getNetworkPolicy",
      "setNetworkPolicy",
      "getPrivilegesPolicy",
      "setPrivilegesPolicy",
      "deletePrivilegesPolicy",
      "getResourcesPolicy",
      "setResourcesPolicy",
      "deleteResourcesPolicy",
      "watchPorts",
      "proxy",
      "controlExec",
      "exec",
      "execHttp",
      "attach",
      "listSessions",
      "killSession",
      "listServices",
      "listCheckpoints",
      "listTasks",
      "gatewayList",
      "gatewayRequest",
    ].sort(),
  );
});
