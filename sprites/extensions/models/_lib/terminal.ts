// SPDX-License-Identifier: MIT
/** Deterministic terminal sizing for newly started TTY commands. @module */
import { z } from "zod";

/** A terminal dimension that fits the kernel's unsigned 16-bit winsize field. */
export const TerminalDimension = z.number().int().min(1).max(65_535);

/** Sprite's native Python, isolated from the command environment's import paths. */
export const TERMINAL_PYTHON = "/.sprite/bin/python3";

/** Set the new PTY's initial winsize, then replace the initializer process. */
export const TERMINAL_PROGRAM = String.raw`import os,sys,fcntl,struct,termios
try:
 fd=next(fd for fd in (0,1,2) if os.isatty(fd))
 size=fcntl.ioctl(fd,termios.TIOCGWINSZ,b"\0"*8)
 rows,cols,xpixel,ypixel=struct.unpack("HHHH",size)
 if sys.argv[1]: rows=int(sys.argv[1])&0xffff
 if sys.argv[2]: cols=int(sys.argv[2])&0xffff
 fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",rows,cols,xpixel,ypixel))
except BaseException:
 os.write(2,b"terminal initialization failed\n")
 os._exit(126)
try:
 os.execvpe(sys.argv[3],sys.argv[4:],os.environ)
except BaseException:
 os.write(2,b"command execution failed\n")
 os._exit(127)`;

export type TerminalCommand = {
  cmd: string[];
  path?: string;
};

/** Wrap a new TTY command only when an initial dimension was supplied. */
export function initializeTerminal(
  command: TerminalCommand,
  rows: number | undefined,
  cols: number | undefined,
): TerminalCommand {
  if (rows === undefined && cols === undefined) return command;
  return {
    cmd: [
      TERMINAL_PYTHON,
      "-I",
      "-c",
      TERMINAL_PROGRAM,
      String(rows ?? ""),
      String(cols ?? ""),
      command.path ?? command.cmd[0],
      ...command.cmd,
    ],
    path: TERMINAL_PYTHON,
  };
}
