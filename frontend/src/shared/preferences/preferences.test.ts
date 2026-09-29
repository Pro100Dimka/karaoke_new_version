import { describe, expect, it } from "vitest";
import { defaultAudioRequest, parsePreferences, acousticLatencyKey } from "./preferences";

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

  it("keeps a karaoke master volume up to 150% and rejects louder values", () => {
    expect(parsePreferences({}).masterGain).toBe(1);
    expect(parsePreferences({ masterGain: 1.5 }).masterGain).toBe(1.5);
    expect(parsePreferences({ masterGain: 0.25 }).masterGain).toBe(0.25);
    expect(parsePreferences({ masterGain: 1.6 }).masterGain).toBe(1);
  });

  it("keeps valid stored values", () => {
    const value = parsePreferences({
      theme: "violet",
      language: "uk",
      librarySort: "played",
      librarySortDirection: "asc",
      reducedMotion: true,
      referenceGain: 0.37,
      karaokeSpeed: 0.85,
      karaokeKeyShift: -3,
      karaokeEffects: { echo: 0.2, reverb: 0.4, delay: 0.12, autoTune: 0.6 },
      pianoRollLayout: { left: 12, top: 34, width: 500, height: 200 },
      keyboardLighting: { enabled: true, mode: "music", brightness: 72, sensitivity: 61 }
    });
    expect(value).toMatchObject({
      theme: "violet",
      language: "uk",
      librarySort: "played",
      librarySortDirection: "asc",
      reducedMotion: true,
      referenceGain: 0.37,
      karaokeSpeed: 0.85,
      karaokeKeyShift: -3,
      karaokeEffects: { echo: 0.2, reverb: 0.4, delay: 0.12, autoTune: 0.6 },
      pianoRollLayout: { left: 12, top: 34, width: 500, height: 200 },
      keyboardLighting: { enabled: true, mode: "music", brightness: 72, sensitivity: 61 }
    });
  });

  it("uses safe keyboard lighting defaults and clamps invalid stored controls", () => {
    expect(parsePreferences({}).keyboardLighting).toEqual({
      enabled: false, mode: "theme", brightness: 70, sensitivity: 50,
    });
    expect(parsePreferences({ keyboardLighting: {
      enabled: true, mode: "random", brightness: 101, sensitivity: -1,
    }}).keyboardLighting).toEqual({
      enabled: true, mode: "theme", brightness: 70, sensitivity: 50,
    });
  });

  it("keeps a latency calibration per device setup and drops invalid measurements", () => {
    const key = acousticLatencyKey({ backend: "ASIO", sampleRate: 0, periodFrames: 0, bufferFrames: 64, inputDeviceId: "in", outputDeviceId: "out" });
    expect(key).toBe("ASIO|in|out|64");
    expect(parsePreferences({ acousticLatencyMs: { [key]: 28, bad: -1, huge: 900, text: "5" } }).acousticLatencyMs)
      .toEqual({ [key]: 28 });
  });

  it("discards a stored piano roll layout that is malformed or has no size", () => {
    expect(parsePreferences({ pianoRollLayout: { left: 1, top: 2 } }).pianoRollLayout).toBeNull();
    expect(parsePreferences({ pianoRollLayout: { left: 1, top: 2, width: 0, height: 100 } }).pianoRollLayout).toBeNull();
    expect(parsePreferences({ pianoRollLayout: "nope" }).pianoRollLayout).toBeNull();
  });
});
