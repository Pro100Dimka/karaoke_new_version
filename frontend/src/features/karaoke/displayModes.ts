import type { KaraokeDisplayMode } from "../../shared/preferences/preferences";

export interface DisplayCapabilities {
  hasLyrics: boolean;
  hasNotes: boolean;
  hasLivePitch: boolean;
}

const requirements: Record<KaraokeDisplayMode, (capabilities: DisplayCapabilities) => boolean> = {
  lyricsPiano: capabilities => capabilities.hasLyrics && capabilities.hasNotes,
  lyricsOnly: capabilities => capabilities.hasLyrics,
  lyricsPitch: capabilities => capabilities.hasLyrics && capabilities.hasLivePitch,
  minimal: () => true
};

const fallbackOrder: readonly KaraokeDisplayMode[] = ["lyricsPiano", "lyricsOnly", "minimal"];

export const availableDisplayModes = (capabilities: DisplayCapabilities): readonly KaraokeDisplayMode[] =>
  (Object.keys(requirements) as KaraokeDisplayMode[]).filter(mode => requirements[mode](capabilities));

/** The saved preference is kept, but an incompatible song shows the closest mode it can actually support. */
export const effectiveDisplayMode = (
  preferred: KaraokeDisplayMode,
  capabilities: DisplayCapabilities
): KaraokeDisplayMode => {
  if (requirements[preferred](capabilities)) return preferred;
  return fallbackOrder.find(mode => requirements[mode](capabilities)) ?? "minimal";
};
