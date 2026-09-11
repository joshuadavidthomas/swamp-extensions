// SPDX-License-Identifier: MIT
import { assertEquals } from "@std/assert";
import {
  initializeTerminal,
  TERMINAL_PROGRAM,
  TERMINAL_PYTHON,
} from "./terminal.ts";

Deno.test("terminal initializer preserves executable path separately from argv0", () => {
  const original = { cmd: ["display-name", "one", "two"], path: "/bin/tool" };
  const wrapped = initializeTerminal(original, 24, 80);
  assertEquals(wrapped.path, TERMINAL_PYTHON);
  assertEquals(wrapped.cmd.slice(0, 4), [
    TERMINAL_PYTHON,
    "-I",
    "-c",
    TERMINAL_PROGRAM,
  ]);
  assertEquals(wrapped.cmd.slice(4), [
    "24",
    "80",
    "/bin/tool",
    "display-name",
    "one",
    "two",
  ]);
  assertEquals(original, {
    cmd: ["display-name", "one", "two"],
    path: "/bin/tool",
  });
});

Deno.test("terminal initializer supports partial sizes and leaves unsized commands alone", () => {
  assertEquals(initializeTerminal({ cmd: ["tool"] }, undefined, undefined), {
    cmd: ["tool"],
  });
  assertEquals(
    initializeTerminal({ cmd: ["tool", "arg"] }, 12, undefined).cmd.slice(4),
    ["12", "", "tool", "tool", "arg"],
  );
  assertEquals(
    initializeTerminal({ cmd: ["tool"] }, undefined, 34).cmd.slice(4),
    ["", "34", "tool", "tool"],
  );
});
