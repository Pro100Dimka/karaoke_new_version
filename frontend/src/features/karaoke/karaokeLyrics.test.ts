import { describe, expect, it } from "vitest";
import type { EditorWord } from "../editor/editorModel";
import { buildLines, currentLineIndex, letterProgress, pitchRange, wordProgress } from "./karaokeLyrics";

const word = (id: string, start: number, end: number): EditorWord => ({ id, text: id, start, end });

describe("karaoke lyrics model", () => {
  it("starts a new line after a long instrumental gap", () => {
    const lines = buildLines([word("a", 0, 1), word("b", 1, 2), word("c", 6, 7)]);
    expect(lines.map(line => line.words.map(item => item.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("limits how many words share a line", () => {
    const words = Array.from({ length: 10 }, (_, index) => word(String(index), index, index + 0.9));
    expect(buildLines(words).map(line => line.words.length)).toEqual([8, 2]);
  });

  it("points at the upcoming line during a gap and the last line after the end", () => {
    const lines = buildLines([word("a", 0, 1), word("b", 5, 6)]);
    expect(currentLineIndex(lines, 0.5)).toBe(0);
    expect(currentLineIndex(lines, 3)).toBe(1);
    expect(currentLineIndex(lines, 99)).toBe(1);
    expect(currentLineIndex([], 1)).toBe(-1);
  });

  it("fills a word continuously between its timing bounds", () => {
    const target = word("a", 2, 4);
    expect([wordProgress(target, 1), wordProgress(target, 3), wordProgress(target, 5)]).toEqual([0, 0.5, 1]);
  });

  it("derives the piano-roll range from notes or the chosen vocal range", () => {
    const notes = [
      { id: "n1", wordId: "a", pitch: 60, start: 0, end: 1 },
      { id: "n2", wordId: "a", pitch: 70, start: 1, end: 2 }
    ];
    expect(pitchRange(notes, "auto")).toEqual({ min: 58, max: 72 });
    expect(pitchRange(notes, "octave")).toEqual({ min: 59, max: 71 });
    expect(pitchRange([], "auto")).toEqual({ min: 48, max: 72 });
  });

  it("moves quickly over consonants and lingers on the sung vowel", () => {
    const sung = { ...word("a", 0, 4), text: "друг" };
    const early = letterProgress(sung, 0.2);
    const middle = letterProgress(sung, 2);
    expect(early).toBeGreaterThan(0.25);
    expect(middle).toBeGreaterThan(0.5);
    expect(middle).toBeLessThan(0.75);
    expect(letterProgress(sung, 0)).toBe(0);
    expect(letterProgress(sung, 4)).toBe(1);
  });
});
