import { describe, expect, it } from "vitest";
import type { EditorWord } from "../editor/editorModel";
import { buildLines, currentLineIndex, letterProgress, notesByWord, pitchRange, wordProgress } from "./karaokeLyrics";

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

  it("advances the word only while its notes sound", () => {
    const sung = word("a", 0, 10);
    const notes = [
      { id: "n1", wordId: "a", pitch: 60, start: 1, end: 3 },
      { id: "n2", wordId: "a", pitch: 62, start: 7, end: 9 }
    ];
    const byWord = notesByWord(notes);
    const at = (position: number) => letterProgress(sung, byWord.get("a"), position);
    expect([at(0.5), at(2), at(5), at(8), at(9.5)]).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("falls back to the word timing when it has no notes", () => {
    expect(letterProgress(word("a", 2, 4), undefined, 3)).toBe(0.5);
  });
});
