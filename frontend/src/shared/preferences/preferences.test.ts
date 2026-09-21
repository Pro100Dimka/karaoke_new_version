import { describe, expect, it } from "vitest";
import { parsePreferences } from "./preferences";

describe("parsePreferences", () => {
  it("falls back to defaults for unknown values", () => {
    const value = parsePreferences({ theme: "neon", language: "de", musicGain: 4 });
    expect(value.theme).toBe("dark");
    expect(value.language).toBe("ru");
    expect(value.musicGain).toBe(0.82);
  });

  it("keeps valid stored values", () => {
    const value = parsePreferences({ theme: "violet", language: "uk", librarySort: "played", reducedMotion: true });
    expect(value).toMatchObject({ theme: "violet", language: "uk", librarySort: "played", reducedMotion: true });
  });
});
