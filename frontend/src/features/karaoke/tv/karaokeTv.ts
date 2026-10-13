import { createContext, useContext } from "react";

/** A song waiting its turn on the TV. */
export interface QueuedSong {
  id: string;
  title: string;
  artist?: string;
}

/** Karaoke on a TV: the whole screen goes there, and the laptop keeps the Library. */
export interface KaraokeTv {
  /** A second screen is connected and no room is open: Karaoke may move to it. */
  available: boolean;
  /** Karaoke is on the TV right now. */
  active: boolean;
  /** The song on the TV, and the ones waiting after it. */
  songId: string | null;
  queue: readonly QueuedSong[];
  /** Moves the open Karaoke to the TV; the laptop goes back to the Library. */
  send(): void;
  /** Brings Karaoke back from the TV to the laptop. */
  bringBack(): void;
  /** Ends the song on the TV (its take is saved and analysed, as with Stop). */
  stop(): void;
  /** Plays a song on the TV after the current one, or instead of it right away. */
  play(song: QueuedSong, when: "next" | "now"): void;
}

export const KaraokeTvContext = createContext<KaraokeTv | null>(null);

export const useKaraokeTv = (): KaraokeTv | null => useContext(KaraokeTvContext);

/** The queue with `song` added once: at the end, or first when it is to play right away. */
export const queueWith = (
  queue: readonly QueuedSong[],
  song: QueuedSong,
  when: "next" | "now",
): QueuedSong[] => {
  const others = queue.filter((item) => item.id !== song.id);
  return when === "now" ? [song, ...others] : [...others, song];
};
