import { describe, expect, it } from "vitest";
import { noteName, rangeLabel, rangeOf } from "./noteRange";

describe("noteRange", () => {
  it.each([
    [60, "C4"],
    [69, "A4"],
    [61, "C♯4"],
    [0, "C-1"],
    [200, "G9"],
    [-5, "C-1"]
  ])("names MIDI note %i as %s", (midi, expected) => {
    expect(noteName(midi)).toBe(expected);
  });

  it("finds the lowest and highest pitch", () => {
    expect(rangeOf([64, 57, 72, 60])).toEqual({ low: 57, high: 72 });
  });

  it("has no range without notes", () => {
    expect(rangeOf([])).toBeNull();
    expect(rangeLabel(null, 3)).toBe("—");
  });

  it("applies the transposition to both ends", () => {
    expect(rangeLabel({ low: 57, high: 72 }, 2)).toBe("B3 – D5");
  });
});
