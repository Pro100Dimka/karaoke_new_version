import { useEffect, useSyncExternalStore } from "react";

/**
 * Commands for a screen that may not be open yet: they wait until its handler subscribes (e.g. a
 * file opened with the app while the Library is still loading) and are then delivered in order.
 */
export const createCommandQueue = <Command>() => {
  const pending: Command[] = [];
  let handler: ((command: Command) => void) | null = null;
  return {
    push(command: Command): void {
      if (handler) handler(command);
      else pending.push(command);
    },
    subscribe(next: (command: Command) => void): () => void {
      handler = next;
      for (const command of pending.splice(0)) next(command);
      return () => {
        if (handler === next) handler = null;
      };
    },
  };
};

export type LibraryCommand =
  | { type: "addSong" }
  | { type: "importFiles"; paths: readonly string[] }
  | { type: "openRoom"; code?: string };

/** What the desktop asks of the Library: add songs, import opened files, open the room dialog. */
export const libraryCommands = createCommandQueue<LibraryCommand>();

/** A small observable value for `useSyncExternalStore`. */
const createStore = <Value>(initial: Value) => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Value): void {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export interface NowPlaying {
  title: string;
  artist?: string;
  playing: boolean;
  recording: boolean;
  togglePlayback(): void;
}

/** The song open in Karaoke, for the taskbar, tray and Discord; null outside Karaoke. */
export const nowPlaying = createStore<NowPlaying | null>(null);

export const useNowPlaying = (): NowPlaying | null =>
  useSyncExternalStore(nowPlaying.subscribe, nowPlaying.get, nowPlaying.get);

/** Karaoke publishes what it plays while it is open, and clears it when it closes. */
export const usePublishNowPlaying = (value: NowPlaying | null): void => {
  const { title, artist, playing, recording, togglePlayback } = value ?? {};
  useEffect(() => {
    nowPlaying.set(
      title === undefined || !togglePlayback
        ? null
        : { title, artist, playing: playing === true, recording: recording === true, togglePlayback },
    );
  }, [title, artist, playing, recording, togglePlayback]);
  useEffect(() => () => nowPlaying.set(null), []);
};

/** Whether the computer runs on battery; heavy decoration lightens itself then. */
export const onBattery = createStore(false);

export const useOnBattery = (): boolean =>
  useSyncExternalStore(onBattery.subscribe, onBattery.get, onBattery.get);

/** The version of a downloaded, verified update waiting for a restart; null when there is none. */
export const updateReady = createStore<string | null>(null);

export const useUpdateReady = (): string | null =>
  useSyncExternalStore(updateReady.subscribe, updateReady.get, updateReady.get);

/** What the radio plays now, as the station tells it; null while unknown or when it stops. */
export const radioTrack = createStore<{ title: string; artist?: string } | null>(null);

export const useRadioTrack = (): { title: string; artist?: string } | null =>
  useSyncExternalStore(radioTrack.subscribe, radioTrack.get, radioTrack.get);

/** With updates off: the newer version the Library offers; null when there is none. */
export const updateAvailable = createStore<string | null>(null);

export const useUpdateAvailable = (): string | null =>
  useSyncExternalStore(updateAvailable.subscribe, updateAvailable.get, updateAvailable.get);

/** The offered update's download after "Install": 0..100, "failed", or null before it starts. */
export const updateDownload = createStore<number | "failed" | null>(null);

export const useUpdateDownload = (): number | "failed" | null =>
  useSyncExternalStore(updateDownload.subscribe, updateDownload.get, updateDownload.get);

/** Screens connected to the computer; Karaoke can move to a second one (a TV). */
export const displayCount = createStore(1);

export const useDisplayCount = (): number =>
  useSyncExternalStore(displayCount.subscribe, displayCount.get, displayCount.get);

/** Karaoke plays on the TV while the laptop shows the Library. */
export const karaokeOnTv = createStore(false);

export const useKaraokeOnTv = (): boolean =>
  useSyncExternalStore(karaokeOnTv.subscribe, karaokeOnTv.get, karaokeOnTv.get);

/** Fires when the microphone was switched from outside its button (the global mute hotkey). */
export const microphoneToggled = createStore(0);

export const useMicrophoneToggles = (): number =>
  useSyncExternalStore(microphoneToggled.subscribe, microphoneToggled.get, microphoneToggled.get);
