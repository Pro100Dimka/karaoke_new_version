import type { SongDto } from "../../contracts/models";
import type { KaraokeAudioPort } from "./KaraokePorts";

interface Recovery {
  audio: Pick<KaraokeAudioPort,
    "health" | "prepareSong" | "setPlaybackRate" | "setPitchShift" | "seek">;
  song: SongDto | null;
  position: number;
  speed: number;
  key: number;
  isCurrent(): boolean;
}

/** Recreates local native state after AudioService restarts; room playback remains server owned. */
export const recoverKaraokeAudio = async ({
  audio, song, position, speed, key, isCurrent,
}: Recovery): Promise<boolean> => {
  if (!song || (await audio.health()).status !== "ready" || !isCurrent())
    return false;
  await audio.prepareSong(song);
  if (!isCurrent()) return false;
  await audio.setPlaybackRate(speed);
  if (!isCurrent()) return false;
  await audio.setPitchShift(key);
  if (!isCurrent()) return false;
  await audio.seek(position);
  return isCurrent();
};
