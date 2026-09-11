// SPDX-License-Identifier: MIT
/** Raw TCP relay built on the documented Sprite WebSocket exec protocol. @module */
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import type { Query } from "./core.ts";
import { type Channel, openChannel } from "./socket.ts";
import { type SpriteContext, spritePath, verifySprite } from "./sprite-api.ts";

const PYTHON = "/.sprite/bin/python3";
const ACK = new TextEncoder().encode("connected\n");
const PROGRAM = String.raw`import os,socket,sys,threading

def die():
 os.write(2,b"relay failed\n")
 os._exit(1)

def send_input():
 try:
  while True:
   data=os.read(0,65536)
   if not data: break
   sock.sendall(data)
  try: sock.shutdown(socket.SHUT_WR)
  except OSError: pass
 except BaseException: die()

timer=threading.Timer(float(sys.argv[3]),lambda:os._exit(124))
timer.daemon=True
timer.start()
try:
 sock=socket.create_connection((sys.argv[1],int(sys.argv[2])))
except BaseException: die()
os.write(2,b"connected\n")
threading.Thread(target=send_input,daemon=True).start()
try:
 while True:
  data=sock.recv(65536)
  if not data: break
  sys.stdout.buffer.write(data)
  sys.stdout.buffer.flush()
except BaseException: die()
sys.exit(0)`;

const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;
const EOF = 4;

type Exit = { code: number };
type Control = { type: string; exit_code?: number; error?: unknown };

function failure(message: string): Error {
  return new Error(`Sprite exec TCP relay ${message}`);
}

async function readWithSignal(
  channel: Channel,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<Channel["read"]>>> {
  return await new Promise((resolve, reject) => {
    const done = (): void => signal.removeEventListener("abort", aborted);
    const aborted = (): void => {
      done();
      reject(signal.reason ?? failure("was cancelled."));
    };
    signal.addEventListener("abort", aborted, { once: true });
    channel.read().then(
      (message) => {
        done();
        resolve(message);
      },
      (error) => {
        done();
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}

function parseControl(bytes: Uint8Array): Control {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !value || typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) throw new Error();
    const control = value as Control;
    if (control.type === "error" || control.error !== undefined) {
      throw failure("reported an exec protocol error.");
    }
    if (
      !["session_info", "debug", "port_opened", "port_closed", "exit"].includes(
        control.type,
      )
    ) {
      throw new Error();
    }
    if (
      control.type === "exit" &&
      (typeof control.exit_code !== "number" ||
        !Number.isInteger(control.exit_code) || control.exit_code < 0)
    ) throw new Error();
    return control;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Sprite exec")) {
      throw error;
    }
    throw failure("received an invalid JSON control frame.");
  }
}

function binaryExit(bytes: Uint8Array): Exit | undefined {
  if (bytes[0] !== EXIT) return undefined;
  if (bytes.length !== 2) throw failure("received an invalid exit frame.");
  return { code: bytes[1] };
}

async function stopOwned(channel: Channel, exited: boolean): Promise<void> {
  if (!exited) {
    try {
      await channel.send(JSON.stringify({ type: "signal", signal: "SIGTERM" }));
    } catch {
      // Closing the owned channel is the final cleanup boundary.
    }
  }
  await channel.close();
}

class ExecProxyDuplex extends Duplex {
  #reading = false;
  #finished = false;
  #exited = false;
  #cleanupPromise: Promise<void> | undefined;
  readonly #onAbort = (): void => {
    this.destroy(failure("was cancelled."));
  };

  constructor(
    private readonly channel: Channel,
    private readonly signal: AbortSignal,
    private readonly timeoutTimer: ReturnType<typeof setTimeout>,
    private readonly deadline: number,
    private readonly queued: Buffer[],
  ) {
    super({ allowHalfOpen: false });
    signal.addEventListener("abort", this.#onAbort, { once: true });
    if (signal.aborted) this.#onAbort();
  }

  override _read(): void {
    if (this.#reading || this.#finished) return;
    while (this.queued.length) {
      if (!this.push(this.queued.shift()!)) return;
    }
    this.#reading = true;
    this.#pump().catch((error) =>
      this.destroy(error instanceof Error ? error : failure("receive failed."))
    );
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#finished) {
        this.signal.throwIfAborted();
        if (performance.now() >= this.deadline) {
          throw failure("exceeded timeoutMs.");
        }
        const message = await readWithSignal(this.channel, this.signal);
        if (this.#finished) return;
        this.signal.throwIfAborted();
        if (performance.now() >= this.deadline) {
          throw failure("exceeded timeoutMs.");
        }
        if (!message) throw failure("WebSocket closed without an exit frame.");
        if (!message.binary) {
          const control = parseControl(message.bytes);
          if (control.type !== "exit") continue;
          await this.#complete(control.exit_code!);
          return;
        }
        if (message.bytes.length === 0) {
          throw failure("received an empty binary frame.");
        }
        const exit = binaryExit(message.bytes);
        if (exit) {
          await this.#complete(exit.code);
          return;
        }
        if (message.bytes[0] !== STDOUT) {
          throw failure("received an unexpected binary stream frame.");
        }
        const chunk = Buffer.from(message.bytes.slice(1));
        if (chunk.length && !this.push(chunk)) return;
      }
    } finally {
      this.#reading = false;
    }
  }

  async #complete(code: number): Promise<void> {
    this.#exited = true;
    this.#finished = true;
    if (code !== 0) throw failure(`process exited with code ${code}.`);
    this.push(null);
    await this.#cleanup(true);
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const frame = new Uint8Array(chunk.length + 1);
    frame[0] = STDIN;
    frame.set(chunk, 1);
    this.channel.send(frame).then(
      () => callback(),
      () => callback(failure("send failed.")),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.#exited) {
      callback();
      return;
    }
    this.channel.send(new Uint8Array([EOF])).then(
      () => callback(),
      () => callback(failure("could not send stdin EOF.")),
    );
  }

  #cleanup(exited = this.#exited): Promise<void> {
    if (!this.#cleanupPromise) {
      clearTimeout(this.timeoutTimer);
      this.signal.removeEventListener("abort", this.#onAbort);
      this.#cleanupPromise = stopOwned(this.channel, exited);
    }
    return this.#cleanupPromise;
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.#finished = true;
    this.#cleanup().then(
      () => callback(error),
      () => callback(error ?? failure("cleanup failed.")),
    );
  }
}

/** Connect to a TCP target from inside one verified Sprite. */
export async function connectExecProxy(
  ctx: SpriteContext,
  host: string,
  port: number,
  connect: typeof openChannel = openChannel,
): Promise<Duplex> {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw failure("target is invalid.");
  }
  ctx.signal.throwIfAborted();
  const deadline = performance.now() + ctx.globalArgs.timeoutMs;
  const timeout = new AbortController();
  const timeoutTimer = setTimeout(
    () => timeout.abort(failure("exceeded timeoutMs.")),
    ctx.globalArgs.timeoutMs,
  );
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  let channel: Channel | undefined;
  let exited = false;
  try {
    await verifySprite({ ...ctx, signal });
    signal.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw failure("exceeded timeoutMs before connecting.");
    const query: Query = {
      cmd: [
        PYTHON,
        "-I",
        "-u",
        "-c",
        PROGRAM,
        host,
        String(port),
        String(remaining / 1000),
      ],
      stdin: true,
      tty: false,
      max_run_after_disconnect: "1s",
    };
    channel = await connect(
      { ...ctx, signal },
      spritePath(ctx, "/exec"),
      query,
    );
    const queued: Buffer[] = [];
    let handshakeBytes = 0;
    let ack = new Uint8Array();
    while (ack.length < ACK.length) {
      signal.throwIfAborted();
      if (performance.now() >= deadline) {
        throw failure("handshake exceeded timeoutMs.");
      }
      const message = await readWithSignal(channel, signal);
      if (!message) throw failure("disconnected before connecting.");
      handshakeBytes += message.bytes.length;
      if (handshakeBytes > ctx.globalArgs.maxResponseBytes) {
        throw failure("handshake exceeded maxResponseBytes.");
      }
      if (!message.binary) {
        const control = parseControl(message.bytes);
        if (control.type === "exit") {
          exited = true;
          throw failure(`process exited with code ${control.exit_code}.`);
        }
        continue;
      }
      if (message.bytes.length === 0) {
        throw failure("received an empty binary frame.");
      }
      const frameExit = binaryExit(message.bytes);
      if (frameExit) {
        exited = true;
        throw failure(`process exited with code ${frameExit.code}.`);
      }
      const stream = message.bytes[0];
      const data = message.bytes.slice(1);
      if (stream === STDOUT) {
        if (data.length) queued.push(Buffer.from(data));
        continue;
      }
      if (stream !== STDERR) {
        throw failure("received an invalid handshake frame.");
      }
      const joined = new Uint8Array(ack.length + data.length);
      joined.set(ack);
      joined.set(data, ack.length);
      ack = joined;
      for (let index = 0; index < ack.length; index++) {
        if (index >= ACK.length || ack[index] !== ACK[index]) {
          throw failure("did not receive the connection acknowledgement.");
        }
      }
    }
    signal.throwIfAborted();
    if (performance.now() >= deadline) {
      throw failure("handshake exceeded timeoutMs.");
    }
    return new ExecProxyDuplex(channel, signal, timeoutTimer, deadline, queued);
  } catch (error) {
    clearTimeout(timeoutTimer);
    if (channel) {
      try {
        await stopOwned(channel, exited);
      } catch {
        // Preserve the bounded protocol or cancellation error.
      }
    }
    throw error;
  }
}
