import { useSyncExternalStore } from "react";
import {
  speakingLevelOf,
  subscribeSpeakingLevels,
} from "../../application/room/roomSpeakingLevelsStore";

/** One participant's voice level, 0–1; only its meter repaints. */
export const useSpeakingLevel = (participant: { id: string; self: boolean }): number =>
  useSyncExternalStore(subscribeSpeakingLevels, () => speakingLevelOf(participant));
