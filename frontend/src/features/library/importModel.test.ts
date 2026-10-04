import { describe, expect, it } from "vitest";
import { isSupportedAudio } from "./importModel";

describe("import model", () => {
  it("accepts only the supported audio formats", () => {
    expect(isSupportedAudio("FLAC")).toBe(true);
    expect(isSupportedAudio("exe")).toBe(false);
  });
});
