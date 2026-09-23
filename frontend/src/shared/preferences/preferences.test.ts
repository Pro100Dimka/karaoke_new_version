import { describe, expect, it } from "vitest";
import { defaultAudioRequest, parsePreferences } from "./preferences";

describe("parsePreferences", () => {
  it("uses the selected device system format on first launch", () => {
    expect(defaultAudioRequest()).toMatchObject({ sampleRate: 0, periodFrames: 0, bufferFrames: 0 });
  });
  it("falls back to defaults for unknown values", () => {
    const value = parsePreferences({ theme: "neon", language: "de", musicGain: 4 });
    expect(value.theme).toBe("dark");
    expect(value.language).toBe("ru");
    expect(value.musicGain).toBe(0.82);
    expect(value.referenceGain).toBe(0);
    expect(value.melodyGain).toBe(0);
  });

  it("keeps valid stored values", () => {
    const value = parsePreferences({
      theme: "violet",
      language: "uk",
      librarySort: "played",
      reducedMotion: true,
      referenceGain: 0.37,
      karaokeSpeed: 0.85,
      karaokeKeyShift: -3,
      karaokeEffects: { echo: 0.2, reverb: 0.4, delay: 0.12 },
      pianoRollLayout: { left: 12, top: 34, width: 500, height: 200 }
    });
    expect(value).toMatchObject({
      theme: "violet",
      language: "uk",
      librarySort: "played",
      reducedMotion: true,
      referenceGain: 0.37,
      karaokeSpeed: 0.85,
      karaokeKeyShift: -3,
      karaokeEffects: { echo: 0.2, reverb: 0.4, delay: 0.12 },
      pianoRollLayout: { left: 12, top: 34, width: 500, height: 200 }
    });
  });

  it("discards a stored piano roll layout that is malformed or has no size", () => {
    expect(parsePreferences({ pianoRollLayout: { left: 1, top: 2 } }).pianoRollLayout).toBeNull();
    expect(parsePreferences({ pianoRollLayout: { left: 1, top: 2, width: 0, height: 100 } }).pianoRollLayout).toBeNull();
    expect(parsePreferences({ pianoRollLayout: "nope" }).pianoRollLayout).toBeNull();
  });
});
