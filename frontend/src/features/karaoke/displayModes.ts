export interface DisplayCapabilities {
  hasLyrics: boolean;
  hasNotes: boolean;
}

export interface StageLayers {
  showNotes: boolean;
  showLyrics: boolean;
}

/** The saved switches are kept, but a layer the song has no data for is never shown; with nothing left the minimal stage appears. */
export const effectiveStageLayers = (wanted: StageLayers, capabilities: DisplayCapabilities): StageLayers => ({
  showNotes: wanted.showNotes && capabilities.hasNotes,
  showLyrics: wanted.showLyrics && capabilities.hasLyrics
});
