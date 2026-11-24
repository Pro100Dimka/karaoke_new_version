import type {
  EditorDocument,
  EditorNote,
  EditorWord,
} from '../../application/editor/editorModel';
import type { VocalRange } from '../../application/library/songPreferences';

export interface LyricLine {
  words: readonly EditorWord[];
  start: number;
  end: number;
}

export const lyricSilenceSeconds = 3;

const writtenLineSizes = (
  lyrics: string | undefined,
  wordCount: number,
): number[] | null => {
  const sizes = (lyrics ?? '')
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
  bpm: number | undefined,
): EditorWord[][] => {
  const beatSeconds =
    bpm && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : undefined;
  const pauseSeconds = beatSeconds
    ? Math.max(0.2, Math.min(0.35, beatSeconds / 2))
    : 0.35;
  const phraseSeconds = beatSeconds ? 4 * beatSeconds : 6;
  let writtenEnd = sizes?.[0] ?? words.length;
  let writtenLine = 0;
  const lines: EditorWord[][] = [];
  for (const [index, word] of words.entries()) {
    const writtenBreak = index === writtenEnd;
    if (writtenBreak) writtenEnd += sizes?.[++writtenLine] ?? 0;
    const current = lines.at(-1);
    const previous = current?.at(-1);
    const gap = previous ? word.start - previous.end + 1e-6 : 0;
    const startsNewLine =
      !current ||
      !previous ||
      writtenBreak ||
      (!sizes &&
        word.start - (current[0]?.start ?? word.start) >= phraseSeconds) ||
      gap >= pauseSeconds ||
      (/[,;:.!?…]$/.test(previous.text) && gap >= pauseSeconds / 4);
    const orphanPreposition =
      current?.length === 1 &&
      previous !== undefined &&
      previous.end - previous.start < 0.8 &&
      ['в', 'у', 'з', 'с', 'к', 'a', 'an', 'the', 'to', 'of', 'in'].includes(
        previous?.text.toLowerCase() ?? '',
      ) &&
      gap < lyricSilenceSeconds;
    if (startsNewLine && !orphanPreposition) lines.push([word]);
    else if (current) current.push(word);
  }
  return lines;
};

export const buildLines = (
  words: readonly EditorWord[],
  lyrics?: string,
  bpm?: number,
  activity?: EditorDocument['vocalActivity'],
): readonly LyricLine[] =>
  groupWords(words, writtenLineSizes(lyrics, words.length), bpm)
    .map((group) => ({
      words: group,
      start: group[0]?.start ?? 0,
      end: group.reduce((end, word) => Math.max(end, word.end), 0),
    }))
    .filter(
      (line) =>
        !activity?.length ||
        activity.some(([start, end]) => start < line.end && end > line.start),
    );

interface LineBlock {
  from: number;
  to: number;
  start: number;
  lastStart: number;
  end: number;
}
const lineBlocks = new WeakMap<readonly LyricLine[], readonly LineBlock[]>();

/** Immutable document lines retain source order, including overlapping timings. */
const firstLine = (
  lines: readonly LyricLine[],
  position: number,
  active: boolean,
): number => {
  let blocks = lineBlocks.get(lines);
  if (!blocks) {
    const built: LineBlock[] = [];
    for (let from = 0; from < lines.length; from += 128) {
      const to = Math.min(lines.length, from + 128);
      let start = Infinity;
      let lastStart = -Infinity;
      let end = -Infinity;
      for (let index = from; index < to; index++) {
        const line = lines[index]!;
        start = Math.min(start, line.start);
        lastStart = Math.max(lastStart, line.start);
        end = Math.max(end, line.end);
      }
      built.push({ from, to, start, lastStart, end });
    }
    blocks = built;
    lineBlocks.set(lines, blocks);
  }
  for (const block of blocks) {
    if (
      active
        ? block.start > position || block.end < position
        : block.lastStart <= position
    )
      continue;
    for (let index = block.from; index < block.to; index++) {
      const line = lines[index]!;
      if (
        active
          ? position >= line.start && position <= line.end
          : line.start > position
      )
        return index;
    }
  }
  return -1;
};

/** First future line in document order; shared with the credits camera. */
export const nextLineIndex = (
  lines: readonly LyricLine[],
  position: number,
): number => firstLine(lines, position, false);

export const currentLineIndex = (
  lines: readonly LyricLine[],
  position: number,
): number => {
  if (lines.length === 0) return -1;
  const active = firstLine(lines, position, true);
  if (active >= 0) return active;
  const upcoming = nextLineIndex(lines, position);
  const previous = lines[upcoming - 1];
  const next = lines[upcoming];
  if (
    previous &&
    next &&
    position - previous.end < lyricSilenceSeconds &&
    next.start - position > lyricSilenceSeconds
  )
    return upcoming - 1;
  return upcoming >= 0 ? upcoming : lines.length - 1;
};

export interface LineDisplayPhase {
  kind: 'text' | 'countdown' | 'empty';
  opacity?: number;
  /** Three seconds of lead-in, counting down to the next vocal entry. */
  countdown?: number;
}

export const upcomingLinePhase = (
  lines: readonly LyricLine[],
  lineIndex: number,
  position: number,
): LineDisplayPhase => {
  const line = lines[lineIndex];
  if (!line) return { kind: 'text' };
  const previousEnd = lines[lineIndex - 1]?.end ?? 0;
  const longGap = line.start - previousEnd > lyricSilenceSeconds;
  const secondsUntilStart = line.start - position;
  const kind =
    (
      [
        [
          'empty',
          position >= line.end + lyricSilenceSeconds ||
            (longGap && secondsUntilStart > lyricSilenceSeconds),
        ],
        ['countdown', longGap && secondsUntilStart > 0.65],
      ] as const
    ).find(([, active]) => active)?.[0] ?? 'text';
  const followedBySilence =
    (lines[lineIndex + 1]?.start ?? Infinity) - line.end > lyricSilenceSeconds;
  const fadeOut = followedBySilence
    ? (line.end + lyricSilenceSeconds - position) / 0.7
    : 1;
  const fadeIn =
    kind === 'countdown' ? (lyricSilenceSeconds - secondsUntilStart) / 0.45 : 1;
  const opacity = Math.max(0, Math.min(1, fadeOut, fadeIn));
  return {
    kind,
    ...(kind !== 'empty' && opacity < 1 ? { opacity } : {}),
    ...(kind === 'countdown'
      ? { countdown: Math.ceil(secondsUntilStart) }
      : {}),
  };
};

const vowels = /[aeiouyаеёиоуыэюяіїє]/i;
// Punctuation and silent signs have no separate sound; they share the preceding sounding group.
const punctuation = /[\s.,!?;:'’ʼ‘"()\-–—…«»„“”]/;
const silentCharacter = /[\p{M}\s.,!?;:'’ʼ‘"()\-–—…«»„“”ьъ]/iu;
export type LetterGeometry = readonly (readonly [number, number])[];
const spokenIndices = (text: string): number[] =>
  [...text]
    .map((character, index) => (silentCharacter.test(character) ? -1 : index))
    .filter((index) => index >= 0);

const glyphProgress = (
  text: string,
  indices: readonly number[],
  position: number,
  fraction: number,
  geometry?: LetterGeometry,
): number => {
  if (!geometry) return (position + fraction) / indices.length;
  const first = indices[position] ?? 0;
  const next = indices[position + 1];
  const characters = [...text];
  let last = characters.length - 1;
  while (last > first && punctuation.test(characters[last] ?? '')) last--;
  const start = geometry[first]?.[0] ?? 0;
  const end =
    next === undefined
      ? (geometry[last]?.[1] ?? 1)
      : (geometry[next]?.[0] ?? 1);
  return start + (end - start) * fraction;
};
const consonantSeconds = 0.07;
const consonantSweepSeconds = 0.14;
const consonantShareLimit = 0.4;

const characterSeconds = (
  text: string,
  duration: number,
  consonantLimit = consonantSeconds,
): number[] => {
  const letters = [...text].filter(
    (character) => !silentCharacter.test(character),
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
    consonantLimit,
    (duration * consonantShareLimit) / consonantCount,
  );
  const vowel = (duration - consonant * consonantCount) / vowelCount;
  return letters.map((character) =>
    vowels.test(character) ? vowel : consonant,
  );
};

export const letterProgress = (
  word: EditorWord,
  position: number,
  geometry?: LetterGeometry,
): number => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  const duration = Math.max(word.end - word.start, 0.001);
  if (word.letters && word.letters.length > 0)
    return timedLetterProgress(
      word.letters,
      word.text,
      (position - word.start) / duration,
      geometry,
    );
  const seconds = characterSeconds(word.text, duration);
  let remaining = position - word.start;
  for (const [index, seconds_] of seconds.entries()) {
    if (remaining < seconds_)
      return glyphProgress(
        word.text,
        spokenIndices(word.text),
        index,
        remaining / seconds_,
        geometry,
      );
    remaining -= seconds_;
  }
  return 1;
};

const timedLetterProgress = (
  starts: readonly number[],
  text: string,
  fraction: number,
  geometry?: LetterGeometry,
  realIndices = spokenIndices(text),
): number => {
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
    glyphProgress(
      text,
      realIndices,
      position,
      Math.min(1, Math.max(0, (fraction - start) / span)),
      geometry,
    ),
  );
};

export const syllableProgress = (
  word: EditorWord,
  position: number,
  geometry?: LetterGeometry,
): number => {
  if (position <= word.start) return 0;
  if (position >= word.end) return 1;
  const characters = [...word.text];
  const indices = spokenIndices(word.text);
  // Repeated vowel letters describe one held sound, not separate measured syllables.
  if (
    /^([aeiouyаеёиоуыэюяіїє])\1{2,}$/iu.test(
      indices.map((i) => characters[i]).join(''),
    )
  )
    return (position - word.start) / (word.end - word.start);
  const starts = word.letters ?? [];
  const hasAnchors = (points: readonly number[]) =>
    points.every((index, i) => {
      const at = starts[index];
      return (
        at !== undefined &&
        at >= 0 &&
        at < 1 &&
        (i === 0 || at > (starts[points[i - 1] ?? 0] ?? 0))
      );
    });
  if (
    !word.lettersApproximate &&
    starts.length === characters.length &&
    hasAnchors(indices)
  )
    return letterProgress(word, position, geometry);
  const nuclei = indices.flatMap((index, i) =>
    vowels.test(characters[index] ?? '') ? [i] : [],
  );
  if (!nuclei.length && indices.some((i) => /\p{L}/u.test(characters[i] ?? '')))
    return letterProgress(
      {
        ...word,
        end: Math.min(
          word.end,
          word.start + consonantSweepSeconds * indices.length,
        ),
        letters: undefined,
      },
      position,
      geometry,
    );
  const groups = [indices[0] ?? 0];
  for (const [i, vowel] of nuclei.entries()) {
    if (i === 0) continue;
    let onset = (nuclei[i - 1] ?? 0) + 1;
    // Keep a sonorant before another consonant with the preceding vowel: аль-бом, май-ка.
    while (
      onset + 1 < vowel &&
      /[йрлмнrlmn]/i.test(characters[indices[onset] ?? 0] ?? '')
    )
      onset++;
    groups.push(indices[onset] ?? 0);
  }
  const measured =
    hasAnchors(groups) && hasAnchors(nuclei.map((i) => indices[i] ?? 0));
  // Missing or collapsed syllable anchors cannot define a separate visual interval.
  const duration = word.end - word.start;
  const boundaries = measured ? groups : [indices[0] ?? 0];
  const phonetic: number[] = [];
  for (const [group, first] of boundaries.entries()) {
    const last = boundaries[group + 1];
    const begin = measured ? (starts[first] ?? 0) : 0;
    const end = last === undefined ? 1 : (starts[last] ?? 1);
    const text = characters.slice(first, last).join('');
    const seconds = characterSeconds(
      text,
      (end - begin) * duration,
      consonantSweepSeconds,
    );
    let at = begin;
    for (const [index, local] of spokenIndices(text).entries()) {
      phonetic[first + local] = at;
      at += (seconds[index] ?? 0) / duration;
    }
  }
  return timedLetterProgress(
    phonetic,
    word.text,
    (position - word.start) / duration,
    geometry ??
      characters.map((_, i) => [
        i / characters.length,
        (i + 1) / characters.length,
      ]),
  );
};

const rangeSemitones = {
  auto: 0,
  octave: 12,
  twoOctaves: 24,
} as const satisfies Record<VocalRange, number>;

interface PitchRange {
  min: number;
  max: number;
}

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

export const pitchHzToMidi = (
  pitchHz: number | undefined,
): number | undefined =>
  pitchHz !== undefined && Number.isFinite(pitchHz) && pitchHz > 0
    ? 69 + 12 * Math.log2(pitchHz / 440)
    : undefined;

export const targetPitchAt = (
  note: Pick<EditorNote, 'start' | 'end' | 'pitch' | 'contour'>,
  position: number,
): number | undefined => {
  const points = note.contour;
  const first = points?.[0];
  if (!points || !first) return note.pitch;
  const fraction = (position - note.start) / (note.end - note.start);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const point = points[middle];
    if (point && point[0] < fraction) low = middle + 1;
    else high = middle;
  }
  const left = points[Math.max(0, low - 1)] ?? first;
  const right = points[Math.min(low, points.length - 1)] ?? first;
  const nearest =
    Math.abs(left[0] - fraction) <= Math.abs(right[0] - fraction)
      ? left
      : right;
  if ((nearest[2] ?? 1) < 0.5) return undefined;
  const weight =
    right[0] > left[0]
      ? Math.max(0, Math.min(1, (fraction - left[0]) / (right[0] - left[0])))
      : 0;
  return note.pitch + left[1] + (right[1] - left[1]) * weight;
};

export const scorableNoteDuration = (
  note: Pick<EditorNote, 'start' | 'end' | 'contour'>,
): number => {
  const points = note.contour;
  const fraction = points?.length
    ? points.reduce((sum, point, index) => {
        if ((point[2] ?? 1) < 0.5) return sum;
        const previous = points[index - 1];
        const next = points[index + 1];
        const start = previous ? (previous[0] + point[0]) / 2 : 0;
        const end = next ? (next[0] + point[0]) / 2 : 1;
        return sum + end - start;
      }, 0)
    : 1;
  return Math.max(0, note.end - note.start) * fraction;
};

export const karaokePitchToleranceSemitones = 1;

export const reliablePitchHz = (
  pitchHz: number | undefined,
  confidence = 1,
): number | undefined => (confidence >= 0.8 ? pitchHz : undefined);

export const pitchAccuracy = (
  pitchHz: number | undefined,
  targetMidi: number | undefined,
): number => {
  const midi = pitchHzToMidi(pitchHz);
  if (midi === undefined || targetMidi === undefined) return 0;
  return Math.max(
    0,
    1 - Math.abs(midi - targetMidi) / karaokePitchToleranceSemitones,
  );
};

export const pitchMatchesTarget = (
  pitchHz: number | undefined,
  targetMidi: number,
): boolean => {
  const midi = pitchHzToMidi(pitchHz);
  return (
    midi !== undefined &&
    Math.abs(midi - targetMidi) <= karaokePitchToleranceSemitones
  );
};

export const noteHitReached = (
  matchedSeconds: number,
  durationSeconds: number,
): boolean =>
  durationSeconds > 0 &&
  matchedSeconds / durationSeconds + Number.EPSILON >= 0.5;
