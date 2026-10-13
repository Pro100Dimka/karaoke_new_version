import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What the interface is doing, as far as Windows, the tray and Discord need to know. The renderer
 * reports it whenever it changes; nothing in it is trusted beyond its shape.
 */
export interface ShellStatus {
  /** The app's own language setting, for the tray, taskbar tooltips and notifications. */
  language: "ru" | "uk" | "en";
  screen: "library" | "karaoke" | "editor" | "other";
  song?: { title: string; artist?: string };
  playing: boolean;
  recording: boolean;
  room?: { code: string; participants: number };
  radio: { available: boolean; enabled: boolean; station?: string };
  /** Undefined outside a room; whether the singer's microphone is off in the room. */
  microphoneMuted?: boolean;
  /** The singer agreed to show their activity on Discord (Settings → Appearance). */
  discordPresence: boolean;
}

/** What the desktop asks the interface to do (taskbar buttons, tray, jump list, links, hotkeys). */
export type ShellCommand =
  | { type: "togglePlayback" }
  | { type: "toggleRadio" }
  | { type: "nextStation" }
  | { type: "addSong" }
  | { type: "openRoom" }
  | { type: "joinRoom"; code: string }
  | { type: "toggleMicrophone" }
  | { type: "importFiles"; paths: string[] }
  | { type: "power"; onBattery: boolean }
  | { type: "updateReady"; version: string }
  | { type: "displays"; count: number };

export const idleShellStatus: ShellStatus = {
  language: "ru",
  screen: "other",
  playing: false,
  recording: false,
  radio: { available: false, enabled: false },
  discordPresence: false,
};

const text = (value: unknown, limit = 200): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The renderer's report as a well-formed status; anything malformed falls back to idle values. */
export const parseShellStatus = (value: unknown): ShellStatus => {
  const raw = record(value) ?? {};
  const screen = ["library", "karaoke", "editor"].includes(raw.screen as string)
    ? (raw.screen as ShellStatus["screen"])
    : "other";
  const songRaw = record(raw.song);
  const title = text(songRaw?.title);
  const roomRaw = record(raw.room);
  const code = text(roomRaw?.code, 32);
  const radioRaw = record(raw.radio) ?? {};
  return {
    language: ["uk", "en"].includes(raw.language as string) ? (raw.language as ShellStatus["language"]) : "ru",
    screen,
    ...(title ? { song: { title, ...(text(songRaw?.artist) ? { artist: text(songRaw?.artist) } : {}) } } : {}),
    playing: raw.playing === true,
    recording: raw.recording === true,
    ...(code
      ? {
          room: {
            code,
            participants:
              typeof roomRaw?.participants === "number" && Number.isFinite(roomRaw.participants)
                ? Math.max(0, Math.min(99, Math.round(roomRaw.participants)))
                : 1,
          },
        }
      : {}),
    radio: {
      available: radioRaw.available === true,
      enabled: radioRaw.enabled === true,
      ...(text(radioRaw.station, 80) ? { station: text(radioRaw.station, 80) } : {}),
    },
    ...(code && typeof raw.microphoneMuted === "boolean" ? { microphoneMuted: raw.microphoneMuted } : {}),
    discordPresence: raw.discordPresence === true,
  };
};

/** Custom URL scheme of invitation links: `advoice://room/AB12CD`. */
export const linkScheme = "advoice";
/** Jump-list tasks start the app with one of these. */
export const taskArguments = { addSong: "--add-song", openRoom: "--open-room" } as const;
export const audioExtensions = [".mp3", ".wav", ".flac", ".m4a", ".ogg"] as const;

const roomCodePattern = /^[A-Za-z0-9-]{3,32}$/;

/** A room code from an invitation link, or undefined for anything else. */
export const roomCodeFromLink = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== `${linkScheme}:`) return undefined;
    // `advoice://room/AB12` parses with host "room" and path "/AB12".
    const parts = [url.hostname, ...url.pathname.split("/")].filter(Boolean);
    if (parts[0]?.toLowerCase() !== "room") return undefined;
    const code = decodeURIComponent(parts[1] ?? "");
    return roomCodePattern.test(code) ? code.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * What a launch (or a second launch handed over to the running app) asks for: an invitation link,
 * a jump-list task or audio files opened with the app. Electron's own switches and the app path
 * are ignored; files must exist and be audio.
 */
export const commandsFromArguments = (
  argv: readonly string[],
  exists: (file: string) => boolean = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
): ShellCommand[] => {
  const commands: ShellCommand[] = [];
  const files: string[] = [];
  for (const argument of argv) {
    const code = argument.toLowerCase().startsWith(`${linkScheme}:`) ? roomCodeFromLink(argument) : undefined;
    if (code) commands.push({ type: "joinRoom", code });
    else if (argument === taskArguments.addSong) commands.push({ type: "addSong" });
    else if (argument === taskArguments.openRoom) commands.push({ type: "openRoom" });
    else if (
      !argument.startsWith("-") &&
      (audioExtensions as readonly string[]).includes(path.extname(argument).toLowerCase()) &&
      exists(argument)
    )
      files.push(path.resolve(argument));
  }
  if (files.length) commands.push({ type: "importFiles", paths: [...new Set(files)].slice(0, 50) });
  return commands;
};

type StatusListener = (status: ShellStatus, previous: ShellStatus) => void;

/**
 * The meeting point of the interface and the desktop: the latest status for the taskbar, tray and
 * Discord, and the commands going the other way. Commands that arrive before the interface listens
 * (a link that launched the app) wait until it says it is ready.
 */
export class DesktopShell {
  private current: ShellStatus = idleShellStatus;
  private readonly listeners = new Set<StatusListener>();
  private readonly pending: ShellCommand[] = [];
  private deliver: ((command: ShellCommand) => void) | null = null;

  status(): ShellStatus {
    return this.current;
  }

  report(value: unknown): void {
    const previous = this.current;
    const next = parseShellStatus(value);
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    this.current = next;
    // Each integration (taskbar, tray, Discord, …) is on its own: one failing never stops the others.
    for (const listener of this.listeners)
      try {
        listener(next, previous);
      } catch (error) {
        console.error("Desktop integration failed to follow the app's status", error);
      }
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The interface is listening; queued commands go out now, in order. */
  connect(deliver: (command: ShellCommand) => void): void {
    this.deliver = deliver;
    for (const command of this.pending.splice(0)) deliver(command);
  }

  /** The interface went away (reload, crash); commands wait for the next one. */
  disconnect(): void {
    this.deliver = null;
  }

  send(command: ShellCommand): void {
    if (this.deliver) this.deliver(command);
    else this.pending.push(command);
  }
}
