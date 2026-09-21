import type { EditorDocument, EditorNote, EditorWord } from "../editor/editorModel";
import type { VocalRange } from "../library/songPreferences";

export interface LyricLine {
  words: readonly EditorWord[];
  start: number;
  end: number;
}

const maxWordsPerLine = 8;
const lineBreakGapSeconds = 1.2;

/** Number of words on each written line, or null when the lyrics do not split into exactly these words. */
const writtenLineSizes = (lyrics: string | undefined, wordCount: number): number[] | null => {
  const sizes = (lyrics ?? "")
    .split(/\r?\n/)
    .map(line => line.split(/\s+/).filter(Boolean).length)
    .filter(size => size > 0);
  return sizes.length > 1 && sizes.reduce((sum, size) => sum + size, 0) === wordCount ? sizes : null;
};

const groupWords = (words: readonly EditorWord[], sizes: readonly number[] | null): EditorWord[][] => {
  if (sizes) {
    let offset = 0;
    return sizes.map(size => words.slice(offset, (offset += size)));
  }
  const lines: EditorWord[][] = [];
  for (const word of words) {
    const current = lines.at(-1);
    const previous = current?.at(-1);
    const startsNewLine =
      !current || !previous || current.length >= maxWordsPerLine || word.start - previous.end > lineBreakGapSeconds;
    if (startsNewLine) lines.push([word]);
    else current.push(word);
  }
  return lines;
};

/**
 * Display lines follow the lyrics as written (one line per row). Without a matching text, or after words were edited,
 * lines are guessed from pauses and a maximum length.
 */
export const buildLines = (words: readonly EditorWord[], lyrics?: string): readonly LyricLine[] =>
  groupWords(words, writtenLineSizes(lyrics, words.length)).map(group => ({
    words: group,
    start: group[0]?.start ?? 0,
    end: group.at(-1)?.end ?? 0
  }));

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

const vowels = /[aeiouyаеёиоуыэюяіїє]/i;
const consonantSeconds = 0.07;
const consonantShareLimit = 0.4;

/** Seconds each character takes: consonants are brief, the vowels share the rest, so a held "друууууг" lingers on the vowel. */
const characterSeconds = (text: string, duration: number): number[] => {
  const characters = [...text];
  const vowelCount = characters.filter(character => vowels.test(character)).length;
  if (vowelCount === 0 || vowelCount === characters.length) return characters.map(() => duration / Math.max(characters.length, 1));
  const consonantCount = characters.length - vowelCount;
  const consonant = Math.min(consonantSeconds, (duration * consonantShareLimit) / consonantCount);
  const vowel = (duration - consonant * consonantCount) / vowelCount;
  return characters.map(character => (vowels.test(character) ? vowel : consonant));
};

/**
 * Fraction of the word's text (0..1) that has been sung. The word's start and end are the times the voice really sounds
 * (the backend spreads words over the active vocal), and inside it the characters are timed by their kind.
 */
export const letterProgress = (word: EditorWord, position: number): number => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  const duration = Math.max(word.end - word.start, 0.001);
  if (word.letters && word.letters.length > 0) return timedLetterProgress(word.letters, (position - word.start) / duration);
  const seconds = characterSeconds(word.text, duration);
  let remaining = position - word.start;
  for (const [index, seconds_] of seconds.entries()) {
    if (remaining < seconds_) return (index + remaining / seconds_) / seconds.length;
    remaining -= seconds_;
  }
  return 1;
};

/** The letters have measured start times: each one is lit from its start until the next letter starts. */
const timedLetterProgress = (starts: readonly number[], fraction: number): number => {
  const count = starts.length;
  const index = Math.max(0, starts.findLastIndex(start => start <= fraction));
  const next = index + 1 < count ? starts[index + 1] : 1;
  const span = Math.max(next - starts[index], 1e-6);
  return Math.min(1, (index + Math.min(1, Math.max(0, (fraction - starts[index]) / span))) / count);
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
