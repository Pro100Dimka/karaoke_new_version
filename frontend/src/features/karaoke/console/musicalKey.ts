import type { EditorNote } from "../../editor/editorModel";

const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"] as const;
const pitchClasses: Readonly<Record<string, number>> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  "E#": 5,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};
const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;

interface MusicalKey {
  root: number;
  minor: boolean;
}

const modulo = (value: number): number => ((value % 12) + 12) % 12;

const parseKey = (value: string | undefined): MusicalKey | null => {
  const normalized = value?.trim().replaceAll("♯", "#").replaceAll("♭", "b");
  if (!normalized || /^(unknown|n\/?a|none|-+)$/i.test(normalized)) return null;
  const match = /^([A-Ga-g])([#b]?)(?:\s*(major|maj|minor|min|m))?(?:\s|$)/i.exec(normalized);
  if (!match) return null;
  const rootName = `${match[1]?.toUpperCase()}${match[2] ?? ""}`;
  const root = pitchClasses[rootName];
  if (root === undefined) return null;
  const mode = (match[3] ?? "").toLowerCase();
  return { root, minor: mode === "m" || mode === "min" || mode === "minor" };
};

const inferKey = (notes: readonly EditorNote[]): MusicalKey => {
  const histogram = Array.from({ length: 12 }, () => 0);
  for (const note of notes) {
    if (!Number.isFinite(note.pitch)) continue;
    const pitchClass = modulo(Math.round(note.pitch));
    histogram[pitchClass] = (histogram[pitchClass] ?? 0) + Math.max(0.05, note.end - note.start);
  }
  if (histogram.every(weight => weight === 0)) return { root: 0, minor: false };

  let best: MusicalKey = { root: 0, minor: false };
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let root = 0; root < 12; root += 1) {
    for (const minor of [false, true]) {
      const profile = minor ? minorProfile : majorProfile;
      const score = histogram.reduce((sum, weight, pitchClass) => sum + weight * profile[modulo(pitchClass - root)]!, 0);
      if (score > bestScore) {
        bestScore = score;
        best = { root, minor };
      }
    }
  }
  return best;
};

/** Returns an actual musical key name for the source song after the current karaoke transposition. */
export const musicalKeyLabel = (sourceKey: string | undefined, semitoneShift: number, notes: readonly EditorNote[]): string => {
  const key = parseKey(sourceKey) ?? inferKey(notes);
  const name = noteNames[modulo(key.root + Math.round(semitoneShift))];
  return `${name}${key.minor ? "m" : ""}`;
};
