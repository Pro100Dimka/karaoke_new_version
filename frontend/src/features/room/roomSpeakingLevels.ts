import { useSyncExternalStore } from "react";

export interface SpeakingLevels {
  /** This computer's microphone. */
  local: number;
  /** Every other participant's voice, by participant id. */
  remote: Readonly<Record<string, number>>;
}

const silent: SpeakingLevels = { local: 0, remote: {} };
let levels = silent;
const listeners = new Set<() => void>();

/**
 * The live voice meters change about twelve times a second. They live outside the room state so a
 * meter update repaints only the meters, not every screen that reads the room.
 */
export const publishSpeakingLevels = (next: SpeakingLevels = silent): void => {
  levels = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const speakingLevelOf = (participant: { id: string; self: boolean }, from = levels): number =>
  Math.max(0, Math.min(1, participant.self ? from.local : (from.remote[participant.id] ?? 0)));

/** One participant's voice level, 0–1; the caller re-renders only when that number changes. */
export const useSpeakingLevel = (participant: { id: string; self: boolean }): number =>
  useSyncExternalStore(subscribe, () => speakingLevelOf(participant));
