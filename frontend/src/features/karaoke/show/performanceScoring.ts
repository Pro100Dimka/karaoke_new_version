import {
  karaokePitchToleranceSemitones,
  scorableNoteDuration,
  noteHitReached,
} from '../karaokeLyrics';
import type { EditorNote } from '../../../application/editor/editorModel';
import type { KaraokeNoteScore } from '../../../contracts/models';

/** A note of the melody as the show scores it; the pitch already includes the key shift. */
export interface ShowNote {
  id: string;
  start: number;
  end: number;
  pitch: number;
  wordId?: string;
  contour?: EditorNote['contour'];
}

/** A sung phrase: the notes of one lyric line. */
export interface ShowPhrase {
  start: number;
  end: number;
  noteIds: readonly string[];
}

interface NoteScore {
  /** Mean closeness of the voiced samples to the target, 0–1. */
  pitchAccuracy: number;
  /** Share of the note actually voiced, 0–1. */
  voicedCoverage: number;
  /** How steadily the pitch was held, 0–1. */
  holdStability: number;
  finalScore: number;
}

export type FinaleGrade = 'normal' | 'good' | 'excellent' | 'legendary';

export type PerformanceEvent =
  | { kind: 'noteCompleted'; note: ShowNote; score: NoteScore }
  | {
      kind: 'phraseCompleted';
      score: number;
      goodInRow: number;
      perfectInRow: number;
    }
  | { kind: 'levelReached'; level: EnergyLevel }
  | { kind: 'songCompleted'; grade: FinaleGrade };

/** The note under the playhead while it is being sung. */
export interface LiveNote {
  note: ShowNote;
  position: number;
  target: number;
  /** Accurately sung share of the note so far, 0–1: the note "charges" with it. */
  charge: number;
  /** Closeness of the voice right now, 0–1; 0 when silent. */
  accuracy: number;
  /** Signed distance from the target in semitones; undefined when silent. */
  deviation?: number;
}

export const energyLevels = [
  'calm',
  'awakening',
  'flow',
  'momentum',
  'onFire',
  'headliner',
  'legendary',
] as const;
export type EnergyLevel = (typeof energyLevels)[number];
const levelFloors: Record<EnergyLevel, number> = {
  calm: 0,
  awakening: 15,
  flow: 30,
  momentum: 45,
  onFire: 60,
  headliner: 75,
  legendary: 90,
};

/** How far the energy has come from the current level towards the next one, 0–1 (1 at Legendary). */
export const levelProgress = (energy: number): number => {
  const level = energyLevel(energy);
  const next = energyLevels[energyLevels.indexOf(level) + 1];
  if (!next) return 1;
  return Math.max(
    0,
    Math.min(
      1,
      (energy - levelFloors[level]) / (levelFloors[next] - levelFloors[level]),
    ),
  );
};

export const energyLevel = (energy: number): EnergyLevel =>
  [...energyLevels].reverse().find((level) => energy >= levelFloors[level]) ??
  'calm';

export const goodNoteScore = 0.55;
export const goodPhraseScore = 0.7;
export const perfectPhraseScore = 0.88;
// Pitch inside this distance counts as exact: vibrato and pitch-tracker jitter are part of good singing.
const exactSemitones = 0.2;
/** Forgiveness: the share of a streak a run of misses keeps (one miss only dents it). */
export const streakKeptAfterMisses: Readonly<Record<number, number>> = {
  1: 0.72,
  2: 0.4,
};
const toleranceSemitones = 1;
// Nobody voices a note from its first to its last millisecond; this much counts as fully sung.
const fullCoverage = 0.8;
// Streak time pauses across an instrumental gap longer than this instead of counting the silence.
export const streakGapSeconds = 4;
// The streak needs this long of good singing to bring the energy ~63% of the way up: about a minute of clean
// singing reaches Legendary, so the show keeps growing through the song instead of maxing out in the first verse.
export const streakTimeConstant = 32;
export const energyRisePerSecond = 9;
export const energyFallPerSecond = 2.6;
export const phraseBonusDecayPerSecond = 0.35;
// A forward jump this long is a seek, not a slow frame.
export const seekSeconds = 1.5;

/** Quality of one voiced sample, 0–1: exact inside the vibrato band, nothing outside the tolerance. */
export const sampleQuality = (deviation: number): number => {
  const distance = Math.abs(deviation);
  if (distance <= exactSemitones) return 1;
  return Math.max(
    0,
    1 - (distance - exactSemitones) / (toleranceSemitones - exactSemitones),
  );
};

export interface NoteProgress {
  uncertain: number;
  evaluated: number;
  absoluteDeviation: number;
  voiced: number;
  matched: number;
  quality: number;
  deviationSum: number;
  deviationMin: number;
  deviationMax: number;
  deviations: [deviation: number, seconds: number][];
}

export const emptyProgress = (): NoteProgress => ({
  uncertain: 0,
  evaluated: 0,
  absoluteDeviation: 0,
  voiced: 0,
  matched: 0,
  quality: 0,
  deviationSum: 0,
  deviationMin: Infinity,
  deviationMax: -Infinity,
  deviations: [],
});

export const assessedNoteDuration = (
  note: ShowNote,
  progress: NoteProgress | undefined,
  duration = scorableNoteDuration(note),
  ignoreSilence = false,
): number => {
  if (ignoreSilence) return progress?.evaluated ?? 0;
  return Math.max(duration * 0.25, duration - (progress?.uncertain ?? 0));
};

export const stableSeconds = (progress: NoteProgress, mean: number): number => {
  const { deviationMin: low, deviationMax: high } = progress;
  const lowInside = Math.abs(low - mean) <= karaokePitchToleranceSemitones;
  const highInside = Math.abs(high - mean) <= karaokePitchToleranceSemitones;
  // Both extrema inside means every captured sample qualifies. `voiced` has the
  // same chronological addition order as the full reduction, without replaying it.
  if (lowInside && highInside) return progress.voiced;
  if ((mean < low && !lowInside) || (mean > high && !highInside)) return 0;
  // A mixed range still needs the original exact per-sample decision at this mean.
  return progress.deviations.reduce(
    (seconds, [deviation, duration]) =>
      seconds +
      (Math.abs(deviation - mean) <= karaokePitchToleranceSemitones
        ? duration
        : 0),
    0,
  );
};

export const scoreNote = (
  note: ShowNote,
  progress: NoteProgress,
  scorableDuration = scorableNoteDuration(note),
  ignoreSilence = false,
): NoteScore => {
  const duration = Math.max(
    0.001,
    assessedNoteDuration(note, progress, scorableDuration, ignoreSilence),
  );
  const voicedCoverage = Math.min(
    1,
    progress.voiced / (duration * fullCoverage),
  );
  const pitchAccuracy =
    progress.voiced > 0 ? progress.quality / progress.voiced : 0;
  const mean =
    progress.voiced > 0 ? progress.deviationSum / progress.voiced : 0;
  const holdStability =
    progress.voiced > 0
      ? Math.min(1, stableSeconds(progress, mean) / progress.voiced)
      : 0;
  // The same half-note hit accepted by MelodyRoll must earn the stage's reward.
  const finalScore = Math.min(1, progress.matched / (duration * 0.5));
  return { pitchAccuracy, voicedCoverage, holdStability, finalScore };
};

export const finaleGrade = (
  energy: number,
  recentScore: number,
): FinaleGrade => {
  if (energy >= 88 && recentScore >= 0.88) return 'legendary';
  if (energy >= 68 && recentScore >= 0.75) return 'excellent';
  if (energy >= 40 && recentScore >= 0.6) return 'good';
  return 'normal';
};

export const totalNoteScore = (
  seen: readonly { note: ShowNote; progress: NoteProgress }[],
  durations: WeakMap<ShowNote, number>,
  ignoreSilence: boolean,
  rhythmIntersection: number,
  rhythmUnion: number,
): KaraokeNoteScore => {
  let voiced = 0,
    evaluated = 0,
    uncertain = 0,
    matched = 0,
    absoluteDeviation = 0,
    deviationSum = 0,
    hitNotes = 0;
  // Preserve each field's note order while visiting the score entries only once.
  for (const { note, progress } of seen) {
    voiced += progress.voiced;
    evaluated += progress.evaluated;
    uncertain += progress.uncertain;
    matched += progress.matched;
    absoluteDeviation += progress.absoluteDeviation;
    deviationSum += progress.deviationSum;
    if (
      noteHitReached(
        progress.matched,
        assessedNoteDuration(
          note,
          progress,
          durations.get(note),
          ignoreSilence,
        ),
      )
    )
      hitNotes++;
  }
  const mean = voiced > 0 ? deviationSum / voiced : 0;
  let stable = 0;
  if (voiced > 0)
    for (const { progress } of seen) stable += stableSeconds(progress, mean);
  return {
    version: 3,
    ...(ignoreSilence ? { ignoreSilence: true } : {}),
    expectedPitchSeconds: evaluated + uncertain,
    assessedPitchSeconds: evaluated,
    pitchAccuracyPercent:
      evaluated > 0 ? 100 * Math.min(1, matched / evaluated) : 0,
    meanSemitoneDeviation: absoluteDeviation / Math.max(0.001, voiced),
    hitNotes,
    totalNotes: seen.length,
    rhythmAccuracyPercent:
      rhythmUnion > 0 ? 100 * Math.min(1, rhythmIntersection / rhythmUnion) : 0,
    noteStabilityPercent: voiced > 0 ? 100 * Math.min(1, stable / voiced) : 0,
  };
};
