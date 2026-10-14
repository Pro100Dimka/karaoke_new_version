import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type { DesktopShell, ShellStatus } from "./DesktopShell";
import { shellText } from "./ShellText";

/**
 * The Discord application this presence belongs to (discord.com/developers → New Application →
 * Application ID; the application is named "A&D Voice", which Discord shows as the game).
 * Empty keeps Discord integration off; AD_VOICE_DISCORD_APPLICATION_ID overrides.
 */
export const discordApplicationId = "1559849069424156764";
/** Optional: the key of an image uploaded under the application's Rich Presence → Art Assets. */
export const discordLargeImage = "logo";

const enum Op {
  Handshake = 0,
  Frame = 1,
  Close = 2,
}

/** One Discord IPC message: opcode and length (little-endian uint32 each), then JSON. */
export const encodeFrame = (op: number, payload: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

/** Complete frames in `buffer`, and what is left of an incomplete one. */
export const decodeFrames = (buffer: Buffer): { frames: { op: number; payload: unknown }[]; rest: Buffer } => {
  const frames: { op: number; payload: unknown }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const op = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    if (buffer.length - offset - 8 < length) break;
    const text = buffer.subarray(offset + 8, offset + 8 + length).toString("utf8");
    try {
      frames.push({ op, payload: JSON.parse(text) as unknown });
    } catch {
      frames.push({ op, payload: null });
    }
    offset += 8 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
};

export interface DiscordActivity {
  details: string;
  state?: string;
  timestamps?: { start: number };
  assets?: { large_image: string; large_text: string };
  party?: { id: string; size: [number, number] };
}

/** What Discord shows for the app's status; null clears it (nothing worth showing). */
export const activityFor = (status: ShellStatus, startedAt: number): DiscordActivity | null => {
  const t = (key: Parameters<typeof shellText>[1], values?: Record<string, string | number>) => shellText(status.language, key, values);
  const assets = discordLargeImage ? { assets: { large_image: discordLargeImage, large_text: "A&D Voice" } } : {};
  // The room is described by its size only: its code would let anyone who sees the profile walk in.
  const room = status.room ? { party: { id: "ad-voice-room", size: [status.room.participants, Math.max(8, status.room.participants)] as [number, number] } } : {};
  if (status.screen === "karaoke" && status.song)
    return {
      details: `${t("singing")} «${status.song.title}»`.slice(0, 128),
      ...(status.song.artist ? { state: status.song.artist.slice(0, 128) } : status.room ? { state: t("roomOf", { count: status.room.participants }) } : {}),
      ...(status.playing ? { timestamps: { start: startedAt } } : {}),
      ...assets,
      ...room,
    };
  if (status.screen === "library" && status.radio.enabled)
    return { details: t("listening"), ...(status.radio.station ? { state: status.radio.station.slice(0, 128) } : {}), ...assets, ...room };
  if (status.room) return { details: t("inRoom"), state: t("roomOf", { count: status.room.participants }), ...assets, ...room };
  return { details: t("inLibrary"), ...assets };
};

const pipeNames = Array.from({ length: 10 }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
const retryMilliseconds = 15_000;

/**
 * Rich Presence over Discord's local IPC pipe: what the singer is doing shows on their Discord
 * profile. Off without an application id or while the user turned it off; a closed Discord is
 * retried quietly.
 */
export const startDiscordPresence = (
  shell: DesktopShell,
  enabled: () => boolean,
  applicationId = process.env.AD_VOICE_DISCORD_APPLICATION_ID ?? discordApplicationId,
) => {
  if (!applicationId) return { stop: () => undefined };
  let socket: net.Socket | null = null;
  let ready = false;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let songKey = "";
  let startedAt = Date.now();
  let lastSent = "";

  const send = () => {
    if (!socket || !ready) return;
    const status = shell.status();
    const key = status.song ? `${status.song.title}:${status.song.artist ?? ""}` : "";
    if (key !== songKey) {
      songKey = key;
      startedAt = Date.now();
    }
    const activity = enabled() ? activityFor(status, startedAt) : null;
    const serialized = JSON.stringify(activity);
    if (serialized === lastSent) return;
    lastSent = serialized;
    socket.write(encodeFrame(Op.Frame, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce: randomUUID() }));
  };

  const scheduleRetry = () => {
    socket = null;
    ready = false;
    lastSent = "";
    if (!stopped && !retry) retry = setTimeout(() => ((retry = null), connect(0)), retryMilliseconds).unref();
  };

  const connect = (index: number) => {
    if (stopped) return;
    const pipe = pipeNames[index];
    if (!pipe) return scheduleRetry();
    const candidate = net.connect(pipe);
    let buffer: Buffer = Buffer.alloc(0);
    candidate.once("error", () => {
      candidate.destroy();
      if (socket === candidate) scheduleRetry();
      else connect(index + 1);
    });
    candidate.once("connect", () => {
      socket = candidate;
      candidate.write(encodeFrame(Op.Handshake, { v: 1, client_id: applicationId }));
    });
    candidate.on("data", (chunk: Buffer) => {
      const decoded = decodeFrames(Buffer.concat([buffer, chunk]));
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        const payload = frame.payload as { evt?: string } | null;
        if (frame.op === Op.Close) candidate.destroy();
        else if (payload?.evt === "READY") {
          ready = true;
          send();
        }
      }
    });
    candidate.once("close", () => {
      if (socket === candidate) scheduleRetry();
    });
  };

  connect(0);
  const unsubscribe = shell.onStatus(() => send());
  return {
    /** Re-sends after the user switched the presence on or off. */
    refresh: () => {
      lastSent = "";
      send();
    },
    stop(): void {
      stopped = true;
      unsubscribe();
      if (retry) clearTimeout(retry);
      socket?.destroy();
    },
  };
};
