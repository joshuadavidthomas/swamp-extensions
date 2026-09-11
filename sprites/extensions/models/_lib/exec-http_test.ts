// SPDX-License-Identifier: MIT
import { assertEquals, assertThrows } from "@std/assert";
import { decodeStreamFrame } from "./exec-http.ts";

Deno.test("decodeStreamFrame separates binary output and exit status and rejects malformed frames", () => {
  assertEquals(decodeStreamFrame(new Uint8Array([1, 0, 255])), {
    kind: "stdout",
    data: new Uint8Array([0, 255]),
  });
  assertEquals(decodeStreamFrame(new Uint8Array([2, 128])), {
    kind: "stderr",
    data: new Uint8Array([128]),
  });
  assertEquals(decodeStreamFrame(new Uint8Array([3, 42])), {
    kind: "exit",
    code: 42,
  });
  for (const frame of [[], [0], [3], [3, 0, 0]]) {
    assertThrows(
      () => decodeStreamFrame(new Uint8Array(frame)),
      Error,
      "Sprite exec stream returned an invalid frame.",
    );
  }
});
