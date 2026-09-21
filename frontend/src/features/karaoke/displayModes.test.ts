import { describe, expect, it } from "vitest";
import { availableDisplayModes, effectiveDisplayMode } from "./displayModes";

describe("karaoke display modes", () => {
  it("offers only modes the project data supports", () => {
    const onlyLyrics = { hasLyrics: true, hasNotes: false, hasLivePitch: false };
    expect(availableDisplayModes(onlyLyrics)).toEqual(["lyricsOnly", "minimal"]);
  });

  it("falls back to the nearest available mode without changing the preference", () => {
    expect(effectiveDisplayMode("lyricsPiano", { hasLyrics: true, hasNotes: false, hasLivePitch: false })).toBe("lyricsOnly");
    expect(effectiveDisplayMode("lyricsPiano", { hasLyrics: false, hasNotes: false, hasLivePitch: false })).toBe("minimal");
    expect(effectiveDisplayMode("lyricsPiano", { hasLyrics: true, hasNotes: true, hasLivePitch: false })).toBe("lyricsPiano");
  });
});
