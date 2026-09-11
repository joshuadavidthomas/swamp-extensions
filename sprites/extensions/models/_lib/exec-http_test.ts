// SPDX-License-Identifier: MIT
import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeStreamFrame,
  envPairs,
  EOF_FRAME,
  stdinFrame,
} from "./exec-http.ts";

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

Deno.test("stdinFrame prefixes non-TTY input and preserves TTY bytes", () => {
  const bytes = new Uint8Array([0, 255]);
  assertEquals(stdinFrame(false, bytes), new Uint8Array([0, 0, 255]));
  assertEquals(stdinFrame(true, bytes), bytes);
  assertEquals(stdinFrame(false, new Uint8Array()), new Uint8Array([0]));
});
Deno.test("EOF_FRAME signals the end of stdin", () => {
  assertEquals(EOF_FRAME, new Uint8Array([4]));
});
Deno.test("envPairs encodes values and accepts absent environments", () => {
  assertEquals(envPairs({ A: "a=b", EMPTY: "" }), ["A=a=b", "EMPTY="]);
  assertEquals(envPairs(undefined), []);
  assertEquals(envPairs({}), []);
});
