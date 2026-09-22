import { describe, expect, it } from "vitest";
import type { EditorWord } from "../editor/editorModel";
import { activeNoteId, buildLines, currentLineIndex, letterProgress, pitchRange, wordProgress } from "./karaokeLyrics";

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
    expect(letterProgress(sung, 0)).toBe(0);
    expect(letterProgress(sung, 0.2)).toBeGreaterThan(0.4);
    expect(letterProgress(sung, 2)).toBeGreaterThan(0.5);
    expect(letterProgress(sung, 2)).toBeLessThan(0.75);
    expect(letterProgress(sung, 4)).toBe(1);
  });

  it("breaks lines where the lyrics do", () => {
    const words = [word("a", 0, 1), word("b", 1, 2), word("c", 2, 3), word("d", 3, 4), word("e", 4, 5)];
    const lines = buildLines(words, "a b" + String.fromCharCode(10) + "c d e");
    expect(lines.map(line => line.words.map(item => item.id))).toEqual([["a", "b"], ["c", "d", "e"]]);
  });

  it("falls back to guessed lines when the text no longer matches the words", () => {
    const words = [word("a", 0, 1), word("b", 1, 2), word("c", 8, 9)];
    expect(buildLines(words, "a" + String.fromCharCode(10) + "b").map(line => line.words.length)).toEqual([2, 1]);
  });

  it("finds which of a word's own notes is sounding right now, or none between/outside them", () => {
    const notes = [
      { id: "n1", wordId: "a", pitch: 60, start: 0, end: 1 },
      { id: "n2", wordId: "a", pitch: 62, start: 1, end: 2 },
      { id: "n3", wordId: "b", pitch: 64, start: 0.4, end: 0.6 }
    ];
    expect(activeNoteId(notes, "a", 0.5)).toBe("n1");
    expect(activeNoteId(notes, "a", 1.5)).toBe("n2");
    expect(activeNoteId(notes, "a", 5)).toBeNull();
    expect(activeNoteId(notes, "b", 0.5)).toBe("n3");
    expect(activeNoteId(notes, "a", 0.5)).not.toBe(activeNoteId(notes, "b", 0.5));
  });

  it("follows measured letter times: a held vowel keeps its letter lit for the whole hold", () => {
    // "друг" over 4 s: д at 0, р at 0.1, у at 0.2 (held), г at 3.9 (fractions of the word).
    const held = { ...word("a", 0, 4), text: "друг", letters: [0, 0.025, 0.05, 0.975] };
    expect(letterProgress(held, 0.2)).toBeCloseTo(0.5, 1);
    expect(letterProgress(held, 2)).toBeGreaterThan(0.5);
    expect(letterProgress(held, 2)).toBeLessThan(0.76);
    expect(letterProgress(held, 3.95)).toBeGreaterThan(0.75);
    expect(letterProgress(held, 4)).toBe(1);
  });
});
