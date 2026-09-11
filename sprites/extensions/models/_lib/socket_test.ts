// SPDX-License-Identifier: MIT
import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { type Channel, type Message, readChannel } from "./socket.ts";

Deno.test("readChannel forwards messages, EOF, channel failures, and the winning abort reason", async () => {
  let pending = Promise.withResolvers<Message | null>();
  const channel: Channel = {
    read: () => pending.promise,
    send: () => Promise.resolve(),
    close() {},
    closeCode: () => undefined,
  };
  const signal = new AbortController().signal;
  const message = { binary: true, bytes: new Uint8Array([1, 2]) };
  let read = readChannel(channel, signal, "test");
  pending.resolve(message);
  assertStrictEquals(await read, message);

  pending = Promise.withResolvers();
  read = readChannel(channel, signal, "test");
  pending.resolve(null);
  assertEquals(await read, null);

  pending = Promise.withResolvers();
  read = readChannel(channel, signal, "test");
  const failure = new Error("original channel failure");
  pending.reject(failure);
  assertStrictEquals(await assertRejects(() => read), failure);

  pending = Promise.withResolvers();
  const controller = new AbortController();
  read = readChannel(channel, controller.signal, "test");
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  assertStrictEquals(await assertRejects(() => read), reason);
  pending.reject(failure);
  assertStrictEquals(
    await assertRejects(() => readChannel(channel, controller.signal, "test")),
    reason,
  );
});
