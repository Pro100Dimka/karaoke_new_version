import { describe, expect, it } from "vitest";
import { guessMetadata, isSupportedAudio } from "./importModel";

describe("import model", () => {
  it("accepts only the supported audio formats", () => {
    expect(isSupportedAudio("FLAC")).toBe(true);
    expect(isSupportedAudio("exe")).toBe(false);
  });

  it("derives artist and title from the filename when tags are unknown", () => {
    expect(guessMetadata("Бумбокс - Люди.mp3")).toEqual({ artist: "Бумбокс", title: "Люди" });
    expect(guessMetadata("track.wav")).toEqual({ artist: "", title: "track" });
  });
});
