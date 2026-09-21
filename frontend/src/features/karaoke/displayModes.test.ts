import { describe, expect, it } from "vitest";
import { effectiveStageLayers } from "./displayModes";

describe("karaoke stage layers", () => {
  it("shows a layer only when it is switched on and the song has data for it", () => {
    expect(effectiveStageLayers({ showNotes: true, showLyrics: true }, { hasLyrics: true, hasNotes: false })).toEqual({ showNotes: false, showLyrics: true });
    expect(effectiveStageLayers({ showNotes: true, showLyrics: false }, { hasLyrics: true, hasNotes: true })).toEqual({ showNotes: true, showLyrics: false });
  });

  it("keeps nothing when the song has no lyrics and no notes", () => {
    expect(effectiveStageLayers({ showNotes: true, showLyrics: true }, { hasLyrics: false, hasNotes: false })).toEqual({ showNotes: false, showLyrics: false });
  });
});
