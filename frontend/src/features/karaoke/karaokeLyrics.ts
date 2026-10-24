import type { EditorNote, EditorWord } from "../../application/editor/editorModel";
import type { VocalRange } from "../../application/library/songPreferences";

export interface LyricLine {
  words: readonly EditorWord[];
  start: number;
  end: number;
}

const maxWordsPerLine = 8;
const lineBreakGapSeconds = 1.2;
export const lyricSilenceSeconds = 3;

/** Number of words on each written line, or null when the lyrics do not split into exactly these words. */
const writtenLineSizes = (
  lyrics: string | undefined,
  wordCount: number,
): number[] | null => {
  const sizes = (lyrics ?? "")
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/).filter(Boolean).length)
    .filter((size) => size > 0);
  return sizes.length > 1 &&
    sizes.reduce((sum, size) => sum + size, 0) === wordCount
    ? sizes
    : null;
};

const groupWords = (
  words: readonly EditorWord[],
  sizes: readonly number[] | null,
): EditorWord[][] => {
  if (sizes) {
    let offset = 0;
    return sizes.map((size) => words.slice(offset, (offset += size)));
  }
  const lines: EditorWord[][] = [];
  for (const word of words) {
    const current = lines.at(-1);
    const previous = current?.at(-1);
    const startsNewLine =
      !current ||
      !previous ||
      current.length >= maxWordsPerLine ||
      word.start - previous.end > lineBreakGapSeconds;
    if (startsNewLine) lines.push([word]);
    else current.push(word);
  }
  return lines;
};

/**
 * Display lines follow the lyrics as written (one line per row). Without a matching text, or after words were edited,
 * lines are guessed from pauses and a maximum length.
 */
export const buildLines = (
  words: readonly EditorWord[],
  lyrics?: string,
): readonly LyricLine[] =>
  groupWords(words, writtenLineSizes(lyrics, words.length)).map((group) => ({
    words: group,
    start: group[0]?.start ?? 0,
    end: group.at(-1)?.end ?? 0,
  }));

/** Holds the finished line briefly, then points at the upcoming one; -1 without lyrics. */
export const currentLineIndex = (
  lines: readonly LyricLine[],
  position: number,
): number => {
  if (lines.length === 0) return -1;
  const active = lines.findIndex(
    (line) => position >= line.start && position <= line.end,
  );
  if (active >= 0) return active;
  const upcoming = lines.findIndex((line) => line.start > position);
  const previous = lines[upcoming - 1];
  const next = lines[upcoming];
  if (
    previous && next &&
    position - previous.end < lyricSilenceSeconds &&
    next.start - position > lyricSilenceSeconds
  ) return upcoming - 1;
  return upcoming >= 0 ? upcoming : lines.length - 1;
};

export interface LineDisplayPhase {
  kind: "text" | "empty";
  opacity?: number;
  /** Three seconds of lead-in, counting down to the next vocal entry. */
  countdown?: number;
}

/**
 * Clears both panels after three silent seconds, including the outro. Upcoming words return three
 * seconds before entry; ordinary short gaps retain their text without a countdown.
 */
export const upcomingLinePhase = (
  lines: readonly LyricLine[],
  lineIndex: number,
  position: number,
): LineDisplayPhase => {
  const line = lines[lineIndex];
  if (!line) return { kind: "text" };
  const previousEnd = lines[lineIndex - 1]?.end ?? 0;
  const longGap = line.start - previousEnd > lyricSilenceSeconds;
  const secondsUntilStart = line.start - position;
  const kind = position >= line.end + lyricSilenceSeconds ||
    (longGap && secondsUntilStart > lyricSilenceSeconds) ? "empty" : "text";
  const counting = kind === "text" && longGap && secondsUntilStart > 0;
  const followedBySilence = (lines[lineIndex + 1]?.start ?? Infinity) - line.end > lyricSilenceSeconds;
  const fadeOut = followedBySilence ? (line.end + lyricSilenceSeconds - position) / 0.7 : 1;
  const fadeIn = counting ? (lyricSilenceSeconds - secondsUntilStart) / 0.45 : 1;
  const opacity = Math.max(0, Math.min(1, fadeOut, fadeIn));
  return {
    kind,
    ...(kind === "text" && opacity < 1 ? { opacity } : {}),
    ...(counting ? { countdown: Math.ceil(secondsUntilStart) } : {}),
  };
};

const vowels = /[aeiouyаеёиоуыэюяіїє]/i;
// Punctuation carries no sound of its own, so it never claims a share of the fill -- it rides along
// with whichever real letter comes right before it instead of visibly holding the highlight itself.
const punctuation = /[.,!?;:'"()\-–—…«»„“”]/;
const consonantSeconds = 0.07;
const consonantShareLimit = 0.4;

/** Seconds each character takes: consonants are brief, the vowels share the rest, so a held "друууууг" lingers on the vowel. */
const characterSeconds = (text: string, duration: number): number[] => {
  const letters = [...text].filter(
    (character) => !punctuation.test(character),
  );
  if (letters.length === 0) return [];
  const vowelCount = letters.filter((character) =>
    vowels.test(character),
  ).length;
  if (vowelCount === 0 || vowelCount === letters.length) {
    const each = duration / letters.length;
    return letters.map(() => each);
  }
  const consonantCount = letters.length - vowelCount;
  const consonant = Math.min(
    consonantSeconds,
    (duration * consonantShareLimit) / consonantCount,
  );
  const vowel = (duration - consonant * consonantCount) / vowelCount;
  return letters.map((character) => vowels.test(character) ? vowel : consonant);
};

/**
 * Fraction of the word's text (0..1) that has been sung, using the saved word and letter boundaries.
 * Without letter timings the consonant/vowel distribution is approximate; it never changes the word's bounds.
 */
export const letterProgress = (word: EditorWord, position: number): number => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  const duration = Math.max(word.end - word.start, 0.001);
  if (word.letters && word.letters.length > 0)
    return timedLetterProgress(
      word.letters,
      word.text,
      (position - word.start) / duration,
    );
  const seconds = characterSeconds(word.text, duration);
  let remaining = position - word.start;
  for (const [index, seconds_] of seconds.entries()) {
    if (remaining < seconds_)
      return (index + remaining / seconds_) / seconds.length;
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
const timedLetterProgress = (
  starts: readonly number[],
  text: string,
  fraction: number,
): number => {
  const realIndices = [...text]
    .map((character, index) => (punctuation.test(character) ? -1 : index))
    .filter((index) => index >= 0);
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
  const nextIndex =
    position + 1 < count ? realIndices[position + 1] : undefined;
  const next = nextIndex !== undefined ? (starts[nextIndex] ?? 1) : 1;
  const span = Math.max(next - start, 1e-6);
  return Math.min(
    1,
    (position + Math.min(1, Math.max(0, (fraction - start) / span))) / count,
  );
};

const rangeSemitones = {
  auto: 0,
  octave: 12,
  twoOctaves: 24,
} as const satisfies Record<VocalRange, number>;

export interface PitchRange {
  min: number;
  max: number;
}

/** Vertical range for the piano roll; a display choice only, it never alters audio. */
export const pitchRange = (
  notes: readonly EditorNote[],
  range: VocalRange,
): PitchRange => {
  if (notes.length === 0) return { min: 48, max: 72 };
  const pitches = notes.map((note) => note.pitch);
  const low = Math.min(...pitches);
  const high = Math.max(...pitches);
  const span = rangeSemitones[range];
  if (span === 0) return { min: low - 2, max: high + 2 };
  const centre = (low + high) / 2;
  return {
    min: Math.round(centre - span / 2),
    max: Math.round(centre + span / 2),
  };
};

/** Converts a detected frequency to a fractional MIDI note so pitch distance is measured musically. */
export const pitchHzToMidi = (pitchHz: number): number =>
  69 + 12 * Math.log2(pitchHz / 440);

/** The revision's measured target; note edits carry the contour with them. */
export const targetPitchAt = (
  note: Pick<EditorNote, "start" | "end" | "pitch" | "contour">,
  position: number,
): number | undefined => {
  const points = note.contour;
  if (!points?.length) return note.pitch;
  const fraction = (position - note.start) / (note.end - note.start);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]![0] < fraction) low = middle + 1;
    else high = middle;
  }
  const left = points[Math.max(0, low - 1)]!;
  const right = points[Math.min(low, points.length - 1)]!;
  const nearest = Math.abs(left[0] - fraction) <= Math.abs(right[0] - fraction) ? left : right;
  if ((nearest[2] ?? 1) < 0.5) return undefined;
  const weight = right[0] > left[0] ? Math.max(0, Math.min(1, (fraction - left[0]) / (right[0] - left[0]))) : 0;
  return note.pitch + left[1] + (right[1] - left[1]) * weight;
};

/** Only reliable parts of the saved contour can require a pitch hit. */
export const scorableNoteDuration = (note: Pick<EditorNote, "start" | "end" | "contour">): number => {
  const points = note.contour;
  const fraction = points?.length ? points.reduce((sum, point, index) => {
    if ((point[2] ?? 1) < 0.5) return sum;
    const previous = points[index - 1];
    const next = points[index + 1];
    const start = previous ? (previous[0] + point[0]) / 2 : 0;
    const end = next ? (next[0] + point[0]) / 2 : 1;
    return sum + end - start;
  }, 0) : 1;
  return Math.max(0, note.end - note.start) * fraction;
};

/** A full semitone is forgiving enough for ordinary karaoke singing while still rejecting the adjacent note. */
export const karaokePitchToleranceSemitones = 1;

/** Weak periodicity is an uncertain measurement, not evidence of a wrong sung note. */
export const reliablePitchHz = (pitchHz: number | undefined, confidence = 1): number | undefined =>
  confidence >= 0.8 ? pitchHz : undefined;

/** Places a detected pitch in the octave nearest the target; karaoke scoring compares note names, not vocal register. */
export const pitchMidiNearTarget = (
  pitchHz: number | undefined,
  targetMidi: number | undefined,
): number | undefined => {
  if (!pitchHz || pitchHz <= 0) return undefined;
  const midi = pitchHzToMidi(pitchHz);
  return targetMidi === undefined
    ? midi
    : midi + 12 * Math.round((targetMidi - midi) / 12);
};

/**
 * Pitch proximity in the 0..1 range across the practical karaoke tolerance; exact pitch is 1.
 * Keeping this continuous lets the live marker become greener as the singer approaches the target.
 */
export const pitchAccuracy = (
  pitchHz: number | undefined,
  targetMidi: number | undefined,
): number => {
  const midi = pitchMidiNearTarget(pitchHz, targetMidi);
  if (midi === undefined || targetMidi === undefined) return 0;
  return Math.max(
    0,
    1 - Math.abs(midi - targetMidi) / karaokePitchToleranceSemitones,
  );
};

/** A voiced sample counts as matching while it stays within the practical karaoke tolerance. */
export const pitchMatchesTarget = (
  pitchHz: number | undefined,
  targetMidi: number,
): boolean => {
  const midi = pitchMidiNearTarget(pitchHz, targetMidi);
  return (
    midi !== undefined &&
    Math.abs(midi - targetMidi) <= karaokePitchToleranceSemitones
  );
};

/** A note is awarded after accurate voice covers at least half of its full duration. */
export const noteHitReached = (
  matchedSeconds: number,
  durationSeconds: number,
): boolean =>
  durationSeconds > 0 &&
  matchedSeconds / durationSeconds + Number.EPSILON >= 0.5;
