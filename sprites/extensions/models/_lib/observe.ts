// SPDX-License-Identifier: MIT
/** Bounded filesystem and listening-port observations. @module */
import { z } from "zod";
import { deadline, method, type Query, resource } from "./core.ts";
import {
  type Channel,
  type ConnectChannel,
  openChannel,
  readChannel,
} from "./socket.ts";
import { type SpriteContext, spritePath } from "./sprite-api.ts";
const EventKind = z.enum(["write", "create", "remove", "rename", "chmod"]);
const Subscribed = z.object({
  type: z.literal("subscribed"),
  paths: z.array(z.string()).optional(),
});
const WatchEvent = z.object({
  type: z.literal("event"),
  path: z.string().optional(),
  event: EventKind.optional(),
  timestamp: z.string().optional(),
  size: z.number().optional(),
  isDir: z.boolean().optional(),
});
const WatchError = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
});
const WatchMessage = z.discriminatedUnion("type", [
  Subscribed,
  WatchEvent,
  WatchError,
]);
const WatchOutput = z.object({
  events: z.array(WatchEvent),
  truncated: z.literal(true).describe(
    "True because observation ends at durationMs or maxEvents, not at an exhaustive filesystem boundary.",
  ),
});

const WatchArgs = z.object({
  paths: z.array(z.string()).min(1),
  recursive: z.boolean().default(false),
  workingDir: z.string().min(1).default("/"),
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxEvents: z.number().int().positive().max(100_000).default(1_000),
});

const MAX_PORTS = 100_000;

const PortNumber = z.number().int().min(1).max(65_535);
const PortNotification = z.object({
  type: z.enum(["port_opened", "port_closed"]),
  port: PortNumber,
  address: z.string(),
  pid: z.number().int(),
});
const PortList = z.object({
  type: z.literal("port_list"),
  ports: z.array(PortNotification).max(MAX_PORTS).nullable().describe(
    "Current listening ports. The native Go endpoint may encode an empty slice as null.",
  ),
});
const PortWatchOutput = z.object({
  initialPorts: z.array(PortNotification).max(MAX_PORTS).describe(
    "Initial listening-port snapshot; a native null snapshot is normalized to an empty array.",
  ),
  notifications: z.array(PortNotification).max(MAX_PORTS),
  truncated: z.literal(true).describe(
    "True because observation ends at durationMs or maxEvents, not at an exhaustive event boundary.",
  ),
});
const PortWatchArgs = z.object({
  durationMs: z.number().int().positive().max(2_147_483_647),
  maxEvents: z.number().int().positive().max(MAX_PORTS).default(1_000).describe(
    "Maximum incremental notifications; initial snapshot entries do not count toward this limit.",
  ),
});

const STOP = Symbol("observation duration elapsed");

type Observation<F, E, T> = {
  connect: ConnectChannel;
  path: string;
  query?: Query;
  subscribe?: string;
  first: (bytes: Uint8Array) => F;
  eventSchema: z.ZodType<E>;
  event: (value: E) => T;
  operation: string;
  cap: number;
  byteBound: number;
  durationMs: number;
};

function decodeFrame<S extends z.ZodType>(
  bytes: Uint8Array,
  schema: S,
  error: string,
): z.output<S> {
  try {
    return schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new Error(error);
  }
}

async function observe<F, E, T>(
  ctx: SpriteContext,
  options: Observation<F, E, T>,
): Promise<{ first: F; events: T[] }> {
  const budget = deadline(ctx);
  const { signal } = budget;
  let channel: Channel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    ctx.signal.throwIfAborted();
    budget.check(`${options.operation} exceeded timeoutMs.`);
  };
  try {
    check();
    channel = await options.connect(
      { ...ctx, signal },
      spritePath(ctx, options.path),
      options.query,
    );
    check();
    if (options.subscribe !== undefined) {
      await channel.send(options.subscribe);
      check();
    }
    let receivedBytes = 0;
    const read = async () => {
      const message = await readChannel(channel!, signal, options.operation);
      if (message) {
        receivedBytes += message.bytes.length;
        if (receivedBytes > options.byteBound) {
          throw new Error(
            `${options.operation} exceeded maxResponseBytes; no result was saved.`,
          );
        }
      }
      return message;
    };
    const initial = await read();
    check();
    if (!initial) {
      throw new Error(
        `${options.operation} disconnected before its first message.`,
      );
    }
    if (initial.binary) {
      throw new Error(
        `${options.operation} returned an unexpected binary frame.`,
      );
    }
    const first = options.first(initial.bytes);
    const durationDeadline = performance.now() + options.durationMs;
    const stopped = new Promise<typeof STOP>((resolve) => {
      timer = setTimeout(() => resolve(STOP), options.durationMs);
    });
    const events: T[] = [];
    while (events.length < options.cap) {
      check();
      if (performance.now() >= durationDeadline) break;
      const next = await Promise.race([read(), stopped]);
      check();
      if (next === STOP || performance.now() >= durationDeadline) break;
      if (!next) {
        throw new Error(
          `${options.operation} disconnected before its bounded observation ended.`,
        );
      }
      if (next.binary) {
        throw new Error(
          `${options.operation} returned an unexpected binary frame.`,
        );
      }
      const event = decodeFrame(
        next.bytes,
        options.eventSchema,
        `${options.operation} returned an invalid event.`,
      );
      events.push(options.event(event));
    }
    return { first, events };
  } catch (error) {
    check();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    budget.dispose();
    await channel?.close();
  }
}

function watchError(message: string | undefined, token: string): Error {
  const reason = message?.replaceAll(token, "[redacted]").replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    " ",
  ).slice(0, 512);
  return new Error(
    `Filesystem watch reported an error${reason ? `: ${reason}` : "."}`,
  );
}

export async function observeWatch(
  ctx: SpriteContext,
  input: z.input<typeof WatchArgs>,
  connect: ConnectChannel = openChannel,
): Promise<z.output<typeof WatchOutput>> {
  const args = WatchArgs.parse(input);
  const result = await observe(ctx, {
    connect,
    path: "/fs/watch",
    subscribe: JSON.stringify({
      type: "subscribe",
      paths: args.paths,
      recursive: args.recursive,
      workingDir: args.workingDir,
    }),
    first: (bytes) => {
      const value = decodeFrame(
        bytes,
        WatchMessage,
        "Filesystem watch returned an invalid JSON control frame.",
      );
      if (value.type === "error") {
        throw watchError(value.message, ctx.globalArgs.token);
      }
      if (value.type !== "subscribed") {
        throw new Error(
          "Filesystem watch did not acknowledge its subscription.",
        );
      }
      ctx.logger.info("Filesystem subscription acknowledged");
      return value;
    },
    eventSchema: WatchMessage,
    event: (value) => {
      if (value.type === "error") {
        throw watchError(value.message, ctx.globalArgs.token);
      }
      if (value.type === "subscribed") {
        throw new Error(
          "Filesystem watch returned an unexpected second subscription acknowledgement.",
        );
      }
      return value;
    },
    operation: "Filesystem watch",
    cap: args.maxEvents,
    byteBound: ctx.globalArgs.maxResponseBytes,
    durationMs: args.durationMs,
  });
  return { events: result.events, truncated: true };
}

export async function watchPorts(
  ctx: SpriteContext,
  input: z.input<typeof PortWatchArgs>,
  connect: ConnectChannel = openChannel,
): Promise<z.output<typeof PortWatchOutput>> {
  const args = PortWatchArgs.parse(input);
  const result = await observe(ctx, {
    connect,
    path: "/ports/watch",
    first: (bytes) =>
      decodeFrame(
        bytes,
        PortList,
        "Sprite port watch returned an invalid initial snapshot frame.",
      ),
    eventSchema: PortNotification,
    event: (value) => value,
    operation: "Sprite port watch",
    cap: args.maxEvents,
    byteBound: ctx.globalArgs.maxResponseBytes,
    durationMs: args.durationMs,
  });
  return {
    initialPorts: result.first.ports ?? [],
    notifications: result.events,
    truncated: true,
  };
}

export const observeResources = {
  watchEvents: resource(
    WatchOutput,
    "Bounded filesystem watch events; never an exhaustive history",
    "7d",
  ),
  portEvents: resource(
    PortWatchOutput,
    "Initial listening-port snapshot and bounded incremental notifications",
    "7d",
  ),
};
export const observeMethods = {
  watch: method(
    "Observe acknowledged Sprite filesystem events for a bounded duration",
    WatchArgs,
    "watchEvents",
    WatchOutput,
    (args, ctx: SpriteContext) => observeWatch(ctx, args),
  ),
  watchPorts: method(
    "Observe a Sprite listening-port snapshot and bounded open/close notifications",
    PortWatchArgs,
    "portEvents",
    PortWatchOutput,
    (args, ctx: SpriteContext) => watchPorts(ctx, args),
  ),
};
