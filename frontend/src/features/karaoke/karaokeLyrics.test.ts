import { describe, expect, it } from "vitest";
import type { EditorWord } from "../../application/editor/editorModel";
import {
  buildLines,
  currentLineIndex,
  letterProgress,
  pitchAccuracy,
  noteHitReached,
  pitchMatchesTarget,
  pitchHzToMidi,
  pitchRange,
  targetPitchAt,
  scorableNoteDuration,
  upcomingLinePhase,
  type LyricLine,
} from "./karaokeLyrics";

const word = (id: string, start: number, end: number): EditorWord => ({
  id,
  text: id,
  start,
  end,
});
const line = (start: number, end: number): LyricLine => ({
  words: [word("w", start, end)],
  start,
  end,
});

describe("karaoke lyrics model", () => {
  it("does not grade an uncertain reference fundamental as a singer's wrong note", () => {
    const note = { pitch: 60, start: 0, end: 1, contour: [[0, 0, 1], [0.5, 3, 0.35], [1, 0, 1]] as const };
    expect(targetPitchAt(note, 0.5)).toBeUndefined();
    expect(scorableNoteDuration(note)).toBeCloseTo(0.5);
  });
  it("follows the saved contour and carries it with transposed and resized notes", () => {
    const note = { pitch: 60, start: 2, end: 4, contour: [[0, -0.3], [1, 0.3]] as const };
    expect(targetPitchAt(note, 3)).toBeCloseTo(60);
    expect(targetPitchAt({ ...note, pitch: 63, end: 6 }, 3)).toBeCloseTo(62.85);
  });
  it("measures live pitch proximity on the musical semitone scale", () => {
    expect(pitchHzToMidi(440)).toBeCloseTo(69, 5);
    expect(pitchAccuracy(440, 69)).toBe(1);
    expect(pitchAccuracy(440 * 2 ** (0.3 / 12), 69)).toBeCloseTo(0.7, 5);
    expect(pitchAccuracy(440 * 2 ** (1 / 12), 69)).toBe(0);
    expect(pitchAccuracy(220, 69)).toBe(1);
    expect(pitchAccuracy(undefined, 69)).toBe(0);
  });

  it("requires accurate singing through half of a note before awarding it", () => {
    expect(pitchMatchesTarget(440 * 2 ** (0.45 / 12), 69)).toBe(true);
    expect(pitchMatchesTarget(440 * 2 ** (0.8 / 12), 69)).toBe(true);
    expect(pitchMatchesTarget(440 * 2 ** (1.1 / 12), 69)).toBe(false);
    expect(noteHitReached(0.49, 1)).toBe(false);
    expect(noteHitReached(0.5, 1)).toBe(true);
  });

  it("starts a new line after a long instrumental gap", () => {
    const lines = buildLines([
      word("a", 0, 1),
      word("b", 1, 2),
      word("c", 6, 7),
    ]);
    expect(lines.map((line) => line.words.map((item) => item.id))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("limits how many words share a line", () => {
    const words = Array.from({ length: 10 }, (_, index) =>
      word(String(index), index, index + 0.9),
    );
    expect(buildLines(words).map((line) => line.words.length)).toEqual([8, 2]);
  });

  it("points at the upcoming line during a gap and the last line after the end", () => {
    const lines = buildLines([word("a", 0, 1), word("b", 5, 6)]);
    expect(currentLineIndex(lines, 0.5)).toBe(0);
    expect(currentLineIndex(lines, 3)).toBe(1);
    expect(currentLineIndex(lines, 99)).toBe(1);
    expect(currentLineIndex([], 1)).toBe(-1);
  });

  it("derives the piano-roll range from notes or the chosen vocal range", () => {
    const notes = [
      { id: "n1", wordId: "a", pitch: 60, start: 0, end: 1 },
      { id: "n2", wordId: "a", pitch: 70, start: 1, end: 2 },
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
    const words = [
      word("a", 0, 1),
      word("b", 1, 2),
      word("c", 2, 3),
      word("d", 3, 4),
      word("e", 4, 5),
    ];
    const lines = buildLines(words, "a b" + String.fromCharCode(10) + "c d e");
    expect(lines.map((line) => line.words.map((item) => item.id))).toEqual([
      ["a", "b"],
      ["c", "d", "e"],
    ]);
  });

  it.each([60, 120, 180])("splits a written line at sung pauses at %s BPM without splitting a held word", (bpm) => {
    const beat = 60 / bpm;
    const words = [word("held", 0, 4), word("a", 4.08, 4.3),
      word("b", 4.3 + beat, 4.6 + beat), word("c", 4.65 + beat, 5 + beat),
      word("last", 6 + beat, 7 + beat)];
    const lines = buildLines(words, "held a b c\nlast", bpm);
    expect(lines.map((line) => line.words.map((item) => item.id))).toEqual([
      ["held", "a"], ["b", "c"], ["last"],
    ]);
    expect(lines[0]).toMatchObject({ start: 0, end: 4.3 });
    expect(lines.flatMap((line) => line.words)).toEqual(words);
    expect(lines[0]?.words[0]).toBe(words[0]);
  });

  it("keeps brief articulation gaps together and limits oversized written lines too", () => {
    const words = Array.from({ length: 10 }, (_, index) => word(String(index), index, index + 0.9));
    const original = structuredClone(words);
    const lyrics = words.slice(0, 9).map((item) => item.text).join(" ") + "\n9";
    expect(buildLines(words, lyrics).map((line) => line.words.length)).toEqual([8, 1, 1]);
    expect(words).toEqual(original);
  });

  it("uses a short breath after punctuation instead of leaving the last word orphaned", () => {
    const words = [word("Всё", 0, 0.3), word("равно", 0.3, 0.8), word("вернусь,", 0.8, 2),
      word("хоть", 2.16, 2.3), word("и", 2.3, 2.4), word("мне", 2.4, 2.6),
      word("грустно", 2.6, 3), word("так", 3, 3.2), word("часто", 3.2, 4)];
    expect(buildLines(words, undefined, 100).map((line) => line.words.map((item) => item.text).join(" "))).toEqual([
      "Всё равно вернусь,", "хоть и мне грустно так часто",
    ]);
    // Punctuation without an audible pause must not break continuous singing.
    expect(buildLines([word("Ты,", 0, 1), word("я", 1, 2)], undefined, 100)).toHaveLength(1);
  });

  it("falls back to guessed lines when the text no longer matches the words", () => {
    const words = [word("a", 0, 1), word("b", 1, 2), word("c", 8, 9)];
    expect(
      buildLines(words, "a" + String.fromCharCode(10) + "b").map(
        (line) => line.words.length,
      ),
    ).toEqual([2, 1]);
  });

  it("follows measured letter times: a held vowel keeps its letter lit for the whole hold", () => {
    // "друг" over 4 s: д at 0, р at 0.1, у at 0.2 (held), г at 3.9 (fractions of the word).
    const held = {
      ...word("a", 0, 4),
      text: "друг",
      letters: [0, 0.025, 0.05, 0.975],
    };
    expect(letterProgress(held, 0.2)).toBeCloseTo(0.5, 1);
    expect(letterProgress(held, 2)).toBeGreaterThan(0.5);
    expect(letterProgress(held, 2)).toBeLessThan(0.76);
    expect(letterProgress(held, 3.95)).toBeGreaterThan(0.75);
    expect(letterProgress(held, 4)).toBe(1);
  });

  it("never lets a trailing punctuation mark's own timing affect the fill", () => {
    // "день." over 4 s; the period's own measured slot (the last one) must be irrelevant to the fill --
    // moving it around must never change what fraction of the word reads as sung.
    const latePeriod = {
      ...word("a", 0, 4),
      text: "день.",
      letters: [0, 0.05, 0.1, 0.5, 0.9],
    };
    const earlyPeriod = {
      ...word("a", 0, 4),
      text: "день.",
      letters: [0, 0.05, 0.1, 0.5, 0.51],
    };
    for (const position of [0.1, 1, 2, 3, 3.6, 4]) {
      expect(letterProgress(latePeriod, position)).toBe(
        letterProgress(earlyPeriod, position),
      );
    }
    expect(letterProgress(latePeriod, 4)).toBe(1);
  });

  it("treats letters the same whether or not punctuation is mixed in", () => {
    // Same held vowel shape as the plain "друг" case above, with a trailing "." added after it, given
    // its own (irrelevant) measured slot -- the fill over the real letters must be unaffected by its
    // presence, as long as the real letters keep the same measured start times.
    const plain = {
      ...word("a", 0, 4),
      text: "друг",
      letters: [0, 0.025, 0.05, 0.975],
    };
    const withDot = {
      ...word("a", 0, 4),
      text: "друг.",
      letters: [0, 0.025, 0.05, 0.975, 0.98],
    };
    for (const position of [0.2, 1, 2, 3, 3.95]) {
      expect(letterProgress(withDot, position)).toBeCloseTo(
        letterProgress(plain, position),
        5,
      );
    }
  });

  it("does not slow approximate highlighting when an untimed word includes punctuation", () => {
    const plain = { ...word("a", 0, 4), text: "друг" };
    const punctuated = { ...plain, text: "«друг!»" };
    for (const position of [0.1, 0.2, 1, 2, 3.95, 4])
      expect(letterProgress(punctuated, position)).toBeCloseTo(
        letterProgress(plain, position),
        6,
      );
  });

  describe("upcomingLinePhase", () => {
    it("shows countdown alone, then readable lyrics before the vocal entry", () => {
      const lines = [line(20, 23)];
      for (const position of [17.1, 18.1, 19.1]) {
        expect(upcomingLinePhase(lines, 0, position)).toMatchObject({
          kind: "countdown",
          countdown: Math.ceil(20 - position),
        });
      }
      expect(upcomingLinePhase(lines, 0, 19.4)).toEqual({ kind: "text" });
      expect(upcomingLinePhase(lines, 0, 20)).toEqual({ kind: "text" });
    });

    it("is always just text across an ordinary short gap between lines", () => {
      const lines = [line(0, 2), line(5, 8)];
      for (const position of [2.5, 3, 4, 4.9]) {
        expect(upcomingLinePhase(lines, 1, position)).toEqual({ kind: "text" });
      }
    });

    it("clears a long instrumental gap, counts 3-2-1, then previews the next line", () => {
      const lines = [line(0, 2), line(20, 23)]; // 18 s gap: well past the long-gap threshold
      expect(upcomingLinePhase(lines, 1, 3)).toEqual({ kind: "empty" });
      expect(upcomingLinePhase(lines, 1, 16.9)).toEqual({ kind: "empty" });
      const counts = [17.1, 18.1, 19.1].map(
        (position) => upcomingLinePhase(lines, 1, position).countdown,
      );
      expect(counts).toEqual([3, 2, 1]);
      expect(upcomingLinePhase(lines, 1, 17.5).kind).toBe("countdown");
      expect(upcomingLinePhase(lines, 1, 20)).toEqual({ kind: "text" }); // singing now: no count
    });

    it("applies the same countdown to a long intro before the very first line", () => {
      const lines = [line(20, 23)];
      expect(upcomingLinePhase(lines, 0, 3)).toEqual({ kind: "empty" });
      expect(upcomingLinePhase(lines, 0, 18.5)).toEqual({
        kind: "countdown",
        countdown: 2,
      });
    });

    it("is text once the line is actually singing or once there is no upcoming line", () => {
      const lines = [line(0, 2), line(20, 23)];
      expect(upcomingLinePhase(lines, 1, 21)).toEqual({ kind: "text" });
      expect(upcomingLinePhase(lines, -1, 5)).toEqual({ kind: "text" });
      expect(upcomingLinePhase([], 0, 5)).toEqual({ kind: "text" });
    });
  });
});
