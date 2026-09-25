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

// A gap this long is a real instrumental break, not just the ordinary pause between two sung lines --
// worth clearing the screen for instead of leaving a not-yet-sung line sitting there unfilled the whole
// time. The last few seconds count down to it instead, so the silence never reads as the app having lost
// track of the song, and the line itself appears just before it must be sung, giving a moment to read it.
const longGapSeconds = 10;
const countdownLeadSeconds = 5;
const textReadySeconds = 1;

export interface LineDisplayPhase {
  kind: "text" | "countdown" | "empty";
  /** Whole seconds remaining until the line starts; only set while kind is "countdown". */
  secondsRemaining?: number;
}

/**
 * How the upcoming line should read at `position`, for a long-enough instrumental gap before it: empty
 * while there is still plenty of break left, a countdown as it approaches, then the line's own text early
 * enough to read before it starts. Once the line is actually singing (or the gap before it is short, the
 * ordinary case), this is always just "text" -- the existing display, unchanged.
 */
export const upcomingLinePhase = (lines: readonly LyricLine[], lineIndex: number, position: number): LineDisplayPhase => {
  const line = lines[lineIndex];
  if (!line || position >= line.start) return { kind: "text" };
  const previousEnd = lines[lineIndex - 1]?.end ?? 0;
  if (line.start - previousEnd <= longGapSeconds) return { kind: "text" };
  const secondsUntilStart = line.start - position;
  if (secondsUntilStart <= textReadySeconds) return { kind: "text" };
  if (secondsUntilStart <= countdownLeadSeconds) return { kind: "countdown", secondsRemaining: Math.ceil(secondsUntilStart) };
  return { kind: "empty" };
};

/** 0 before the word, 1 after it, continuous in between. */
export const wordProgress = (word: EditorWord, position: number): number => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  return (position - word.start) / Math.max(word.end - word.start, 0.001);
};

const vowels = /[aeiouyаеёиоуыэюяіїє]/i;
// Punctuation carries no sound of its own, so it never claims a share of the fill -- it rides along
// with whichever real letter comes right before it instead of visibly holding the highlight itself.
const punctuation = /[.,!?;:'"()\-–—…«»„“”]/;
const consonantSeconds = 0.07;
const consonantShareLimit = 0.4;

/** Seconds each character takes: consonants are brief, the vowels share the rest, so a held "друууууг" lingers on the vowel. */
const characterSeconds = (text: string, duration: number): number[] => {
  const characters = [...text];
  const letters = characters.filter(character => !punctuation.test(character));
  if (letters.length === 0) return characters.map(() => 0);
  const vowelCount = letters.filter(character => vowels.test(character)).length;
  if (vowelCount === 0 || vowelCount === letters.length) {
    const each = duration / letters.length;
    return characters.map(character => (punctuation.test(character) ? 0 : each));
  }
  const consonantCount = letters.length - vowelCount;
  const consonant = Math.min(consonantSeconds, (duration * consonantShareLimit) / consonantCount);
  const vowel = (duration - consonant * consonantCount) / vowelCount;
  return characters.map(character =>
    punctuation.test(character) ? 0 : vowels.test(character) ? vowel : consonant
  );
};

/**
 * Fraction of the word's text (0..1) that has been sung. The word's start and end are the times the voice really sounds
 * (the backend spreads words over the active vocal), and inside it the characters are timed by their kind.
 */
export const letterProgress = (word: EditorWord, position: number): number => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  const duration = Math.max(word.end - word.start, 0.001);
  if (word.letters && word.letters.length > 0)
    return timedLetterProgress(word.letters, word.text, (position - word.start) / duration);
  const seconds = characterSeconds(word.text, duration);
  let remaining = position - word.start;
  for (const [index, seconds_] of seconds.entries()) {
    if (remaining < seconds_) return (index + remaining / seconds_) / seconds.length;
    remaining -= seconds_;
  }
  return 1;
};

/**
 * The letters array has one measured start time per character of the word's text (including punctuation,
 * which the backend times the same way it times every character, even though it never actually sounds).
 * Punctuation is skipped here so it never gets its own share of the fill -- without this, a trailing "."
 * or "-" after a held vowel would claim the last slice of the highlight for itself, visibly pausing the
 * fill on a mark instead of the letter that is genuinely still sounding.
 */
const timedLetterProgress = (starts: readonly number[], text: string, fraction: number): number => {
  const realIndices = [...text]
    .map((character, index) => (punctuation.test(character) ? -1 : index))
    .filter(index => index >= 0);
  const count = realIndices.length;
  if (count === 0) return 1;
  let position = 0;
  for (let candidate = count - 1; candidate >= 0; candidate--) {
    const start = starts[realIndices[candidate] ?? -1];
    if (start !== undefined && start <= fraction) {
      position = candidate;
      break;
    }
  }
  const start = starts[realIndices[position] ?? -1] ?? 0;
  const nextIndex = position + 1 < count ? realIndices[position + 1] : undefined;
  const next = nextIndex !== undefined ? (starts[nextIndex] ?? 1) : 1;
  const span = Math.max(next - start, 1e-6);
  return Math.min(1, (position + Math.min(1, Math.max(0, (fraction - start) / span))) / count);
};

/**
 * Stretches each word's earliest note back to the word's own start, display-only. A word's first sung
 * note often starts measurably after the word's own start (leading unvoiced consonants -- с, т, п...
 * genuinely carry no pitch), so the piano roll would otherwise show the note arriving visibly later than
 * the lyric that owns it. The underlying pitch timing is never touched, only where the bar is drawn.
 */
export const notesAlignedToWords = (
  notes: readonly EditorNote[],
  words: readonly EditorWord[]
): readonly EditorNote[] => {
  const wordStart = new Map(words.map(word => [word.id, word.start]));
  const earliestStart = new Map<string, number>();
  for (const note of notes) {
    const current = earliestStart.get(note.wordId);
    if (current === undefined || note.start < current) earliestStart.set(note.wordId, note.start);
  }
  return notes.map(note => {
    const start = wordStart.get(note.wordId);
    const isEarliestForWord = start !== undefined && note.start === earliestStart.get(note.wordId);
    return isEarliestForWord && start < note.start ? { ...note, start } : note;
  });
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

/**
 * Id of the note being sung inside a given word at `position`, or null when the word has no measured pitch there
 * (an unvoiced consonant, or a word the pipeline never matched to a note). Retriggering a pulse on this id change
 * makes the flicker land on the vocal's actual note onsets instead of a fixed, song-independent tempo.
 */
export const activeNoteId = (notes: readonly EditorNote[], wordId: string, position: number): string | null =>
  notes.find(note => note.wordId === wordId && position >= note.start && position <= note.end)?.id ?? null;

/** Converts a detected frequency to a fractional MIDI note so pitch distance is measured musically. */
export const pitchHzToMidi = (pitchHz: number): number => 69 + 12 * Math.log2(pitchHz / 440);

/** A full semitone is forgiving enough for ordinary karaoke singing while still rejecting the adjacent note. */
export const karaokePitchToleranceSemitones = 1;

/** Places a detected pitch in the octave nearest the target; karaoke scoring compares note names, not vocal register. */
export const pitchMidiNearTarget = (pitchHz: number | undefined, targetMidi: number | undefined): number | undefined => {
  if (!pitchHz || pitchHz <= 0) return undefined;
  const midi = pitchHzToMidi(pitchHz);
  return targetMidi === undefined ? midi : midi + 12 * Math.round((targetMidi - midi) / 12);
};

/**
 * Pitch proximity in the 0..1 range across the practical karaoke tolerance; exact pitch is 1.
 * Keeping this continuous lets the live marker become greener as the singer approaches the target.
 */
export const pitchAccuracy = (pitchHz: number | undefined, targetMidi: number | undefined): number => {
  const midi = pitchMidiNearTarget(pitchHz, targetMidi);
  if (midi === undefined || targetMidi === undefined) return 0;
  return Math.max(0, 1 - Math.abs(midi - targetMidi) / karaokePitchToleranceSemitones);
};

/** A voiced sample counts as matching while it stays within the practical karaoke tolerance. */
export const pitchMatchesTarget = (pitchHz: number | undefined, targetMidi: number): boolean => {
  const midi = pitchMidiNearTarget(pitchHz, targetMidi);
  return midi !== undefined && Math.abs(midi - targetMidi) <= karaokePitchToleranceSemitones;
};

/** A note is awarded after accurate voice covers at least half of its full duration. */
export const noteHitReached = (matchedSeconds: number, durationSeconds: number): boolean =>
  durationSeconds > 0 && matchedSeconds / durationSeconds + Number.EPSILON >= 0.5;

export interface KaraokeContentFlags {
  hasLyrics: boolean;
  hasNotes: boolean;
}

export const contentFlags = (document: EditorDocument | null): KaraokeContentFlags => ({
  hasLyrics: (document?.words.length ?? 0) > 0,
  hasNotes: (document?.notes.length ?? 0) > 0
});
