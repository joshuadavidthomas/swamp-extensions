// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
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

Deno.test("execution, attachment, and gateway mutations refuse a replaced Sprite", async () => {
  const cases = [
    { name: "exec", args: { cmd: ["echo", "hello"] } },
    { name: "execHttp", args: { cmd: ["echo", "hello"] } },
    { name: "attach", args: { session_id: "7" } },
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
