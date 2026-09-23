import { describe, expect, it } from "vitest";
import type { EditorNote } from "../../editor/editorModel";
import { musicalKeyLabel } from "./musicalKey";

describe("musicalKeyLabel", () => {
  it("transposes major and minor key names by semitones", () => {
    expect(musicalKeyLabel("Am", 2, [])).toBe("Bm");
    expect(musicalKeyLabel("G", -2, [])).toBe("F");
    expect(musicalKeyLabel("Bb minor", 1, [])).toBe("Bm");
    expect(musicalKeyLabel("F# major", 0, [])).toBe("F♯");
  });

  it("infers a concrete key from notes when metadata is unknown", () => {
    const notes = [60, 64, 67, 72].map((pitch, index) => ({
      id: String(index),
      wordId: "word",
      pitch,
      start: index,
      end: index + 1
    })) satisfies EditorNote[];

    expect(musicalKeyLabel("Unknown", 0, notes)).toMatch(/^[A-G](?:♯)?m?$/);
  });
});
