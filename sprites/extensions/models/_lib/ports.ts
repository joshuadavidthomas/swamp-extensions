// SPDX-License-Identifier: MIT
/** Bounded observation of listening-port snapshots and changes for one Sprite. @module */
import { z } from "zod";
import { resource, type Result } from "./core.ts";
import { type Channel, type ConnectChannel, openChannel } from "./socket.ts";
import { type SpriteContext, spritePath } from "./sprite-api.ts";

const MAX_PORTS = 100_000;
const STOP = Symbol("port observation duration elapsed");

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

async function readWithAbort(
  channel: Channel,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<Channel["read"]>>> {
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Sprite port watch was cancelled."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    channel.read().then(
      (message) => {
        cleanup();
        resolve(message);
      },
      () => {
        cleanup();
        reject(new Error("Sprite port watch transport failed."));
      },
    );
    if (signal.aborted) onAbort();
  });
}

function decodeFrame<S extends z.ZodType>(
  bytes: Uint8Array,
  schema: S,
  kind: string,
): z.output<S> {
  try {
    return schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new Error(`Sprite port watch returned an invalid ${kind} frame.`);
  }
}

/** Read the required initial snapshot, then collect bounded incremental events. */
export async function watchPorts(
  ctx: SpriteContext,
  input: z.input<typeof PortWatchArgs>,
  connect: ConnectChannel = openChannel,
): Promise<z.output<typeof PortWatchOutput>> {
  const args = PortWatchArgs.parse(input);
  ctx.signal.throwIfAborted();
  const globalDeadline = performance.now() + ctx.globalArgs.timeoutMs;
  const timeout = new AbortController();
  const timeoutError = new Error("Sprite port watch exceeded timeoutMs.");
  const timeoutTimer = setTimeout(
    () => timeout.abort(timeoutError),
    ctx.globalArgs.timeoutMs,
  );
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  const checkGlobalDeadline = (): void => {
    signal.throwIfAborted();
    if (performance.now() >= globalDeadline) throw timeoutError;
  };
  try {
    const channel = await connect(
      { ...ctx, signal },
      spritePath(ctx, "/ports/watch"),
    );
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let receivedBytes = 0;
      const read = async (): Promise<Awaited<ReturnType<Channel["read"]>>> => {
        const message = await readWithAbort(channel, signal);
        if (message) {
          receivedBytes += message.bytes.length;
          if (receivedBytes > ctx.globalArgs.maxResponseBytes) {
            throw new Error(
              "Sprite port watch exceeded maxResponseBytes; no result was saved.",
            );
          }
        }
        return message;
      };

      const first = await read();
      checkGlobalDeadline();
      if (!first) {
        throw new Error(
          "Sprite port watch disconnected before its initial snapshot.",
        );
      }
      if (first.binary) {
        throw new Error(
          "Sprite port watch returned a binary initial snapshot frame.",
        );
      }
      const snapshot = decodeFrame(first.bytes, PortList, "initial snapshot");
      const durationDeadline = performance.now() + args.durationMs;
      const stopped = new Promise<typeof STOP>((resolve) => {
        durationTimer = setTimeout(() => resolve(STOP), args.durationMs);
      });
      const notifications: z.output<typeof PortNotification>[] = [];
      while (notifications.length < args.maxEvents) {
        checkGlobalDeadline();
        if (performance.now() >= durationDeadline) break;
        const next = await Promise.race([read(), stopped]);
        checkGlobalDeadline();
        if (next === STOP || performance.now() >= durationDeadline) break;
        if (!next) {
          throw new Error(
            "Sprite port watch disconnected before its bounded observation ended.",
          );
        }
        if (next.binary) {
          throw new Error(
            "Sprite port watch returned an unexpected binary notification frame.",
          );
        }
        notifications.push(
          decodeFrame(next.bytes, PortNotification, "port notification"),
        );
      }
      checkGlobalDeadline();
      const output = PortWatchOutput.parse({
        initialPorts: snapshot.ports ?? [],
        notifications,
        truncated: true,
      });
      checkGlobalDeadline();
      return output;
    } finally {
      if (durationTimer !== undefined) clearTimeout(durationTimer);
      await channel.close();
    }
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/** Port-watch data for composition into the single-Sprite model. */
export const portResources = {
  portEvents: resource(
    PortWatchOutput,
    "Initial listening-port snapshot and bounded incremental notifications",
    "7d",
  ),
};

/** Port-watch methods for composition into the single-Sprite model. */
export const portMethods = {
  watchPorts: {
    description:
      "Observe a Sprite listening-port snapshot and bounded open/close notifications",
    arguments: PortWatchArgs,
    execute: async (
      input: z.input<typeof PortWatchArgs>,
      ctx: SpriteContext,
    ): Promise<Result> => {
      ctx.logger.info("Starting Sprite port watch");
      const output = PortWatchOutput.parse(await watchPorts(ctx, input));
      ctx.signal.throwIfAborted();
      const handle = await ctx.writeResource(
        "portEvents",
        "portEvents",
        output,
      );
      ctx.logger.info("Finished Sprite port watch");
      return { dataHandles: [handle] };
    },
  },
};
