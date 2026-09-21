import type { EditorDocument, EditorNote, EditorWord } from "../editor/editorModel";
import type { VocalRange } from "../library/songPreferences";

export interface LyricLine {
  words: readonly EditorWord[];
  start: number;
  end: number;
}

const maxWordsPerLine = 8;
const lineBreakGapSeconds = 1.2;

/** Words come from the project; only their grouping into display lines is decided here. */
export const buildLines = (words: readonly EditorWord[]): readonly LyricLine[] => {
  const lines: EditorWord[][] = [];
  for (const word of words) {
    const current = lines.at(-1);
    const previous = current?.at(-1);
    const startsNewLine =
      !current || !previous || current.length >= maxWordsPerLine || word.start - previous.end > lineBreakGapSeconds;
    if (startsNewLine) lines.push([word]);
    else current.push(word);
  }
  return lines.map(group => ({
    words: group,
    start: group[0]?.start ?? 0,
    end: group.at(-1)?.end ?? 0
  }));
};

/** Index of the line being sung, or the next upcoming one; -1 when there are no lyrics. */
export const currentLineIndex = (lines: readonly LyricLine[], position: number): number => {
  if (lines.length === 0) return -1;
  const active = lines.findIndex(line => position >= line.start && position <= line.end);
  if (active >= 0) return active;
  const upcoming = lines.findIndex(line => line.start > position);
  return upcoming >= 0 ? upcoming : lines.length - 1;
};

/** 0 before the word, 1 after it, continuous in between. */
export const wordProgress = (word: EditorWord, position: number): number => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  return (position - word.start) / Math.max(word.end - word.start, 0.001);
};

/** Notes of every word, in time order; a word without notes falls back to its own start and end. */
export const notesByWord = (notes: readonly EditorNote[]): ReadonlyMap<string, readonly EditorNote[]> => {
  const grouped = new Map<string, EditorNote[]>();
  for (const note of notes) grouped.set(note.wordId, [...(grouped.get(note.wordId) ?? []), note]);
  for (const list of grouped.values()) list.sort((left, right) => left.start - right.start);
  return grouped;
};

/**
 * Fraction of the word (0..1) that has been sung. It advances only while the singer is actually voicing (inside the word's
 * notes), so a held "друууууг" fills steadily through the long note and pauses inside a word do not move the highlight.
 */
export const letterProgress = (word: EditorWord, wordNotes: readonly EditorNote[] | undefined, position: number): number => {
  if (!wordNotes || wordNotes.length === 0) return wordProgress(word, position);
  const total = wordNotes.reduce((sum, note) => sum + Math.max(note.end - note.start, 0), 0);
  if (total <= 0) return wordProgress(word, position);
  const sung = wordNotes.reduce((sum, note) => sum + Math.min(Math.max(position - note.start, 0), Math.max(note.end - note.start, 0)), 0);
  return Math.min(1, sung / total);
};

export const notesInWindow = (
  notes: readonly EditorNote[],
  position: number,
  windowSeconds: number
): readonly EditorNote[] =>
  notes.filter(note => note.end >= position - windowSeconds * 0.25 && note.start <= position + windowSeconds);

const rangeSemitones = { auto: 0, octave: 12, twoOctaves: 24 } as const satisfies Record<VocalRange, number>;

export interface PitchRange {
  min: number;
  max: number;
}

/** Vertical range for the piano roll; a display choice only, it never alters audio. */
export const pitchRange = (notes: readonly EditorNote[], range: VocalRange): PitchRange => {
  if (notes.length === 0) return { min: 48, max: 72 };
  const pitches = notes.map(note => note.pitch);
  const low = Math.min(...pitches);
  const high = Math.max(...pitches);
  const span = rangeSemitones[range];
  if (span === 0) return { min: low - 2, max: high + 2 };
  const centre = (low + high) / 2;
  return { min: Math.round(centre - span / 2), max: Math.round(centre + span / 2) };
};

export interface KaraokeContentFlags {
  hasLyrics: boolean;
  hasNotes: boolean;
}

export const contentFlags = (document: EditorDocument | null): KaraokeContentFlags => ({
  hasLyrics: (document?.words.length ?? 0) > 0,
  hasNotes: (document?.notes.length ?? 0) > 0
});
