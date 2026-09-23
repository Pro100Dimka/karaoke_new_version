import type { KaraokeOpenMode } from "./useKaraokeSession";

/** Library launches, including room launches, share one full visual introduction lifecycle. */
export const opensWithFullIntroduction = (mode: KaraokeOpenMode): boolean => mode !== "Normal";
