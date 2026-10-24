import { pitchMidiNearTarget, karaokePitchToleranceSemitones, targetPitchAt, noteHitReached, scorableNoteDuration } from "../karaokeLyrics";
import type { EditorNote } from "../../../application/editor/editorModel";
import type { KaraokeNoteScore } from "../../../contracts/models";

/** A note of the melody as the show scores it; the pitch already includes the key shift. */
export interface ShowNote {
  id: string;
  start: number;
  end: number;
  pitch: number;
  wordId?: string;
  contour?: EditorNote["contour"];
}

/** A sung phrase: the notes of one lyric line. */
export interface ShowPhrase {
  start: number;
  end: number;
  noteIds: readonly string[];
}

export interface NoteScore {
  /** Mean closeness of the voiced samples to the target, 0–1. */
  pitchAccuracy: number;
  /** Share of the note actually voiced, 0–1. */
  voicedCoverage: number;
  /** How steadily the pitch was held, 0–1. */
  holdStability: number;
  finalScore: number;
}

export type FinaleGrade = "normal" | "good" | "excellent" | "legendary";

export type PerformanceEvent =
  | { kind: "noteCompleted"; note: ShowNote; score: NoteScore }
  | {
      kind: "phraseCompleted";
      score: number;
      goodInRow: number;
      perfectInRow: number;
    }
  | { kind: "levelReached"; level: EnergyLevel }
  | { kind: "songCompleted"; grade: FinaleGrade };

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
  "calm",
  "awakening",
  "flow",
  "momentum",
  "onFire",
  "headliner",
  "legendary",
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
  "calm";

export const goodNoteScore = 0.55;
const goodPhraseScore = 0.7;
const perfectPhraseScore = 0.88;
// Pitch inside this distance counts as exact: vibrato and pitch-tracker jitter are part of good singing.
const exactSemitones = 0.2;
/** Forgiveness: the share of a streak a run of misses keeps (one miss only dents it). */
const streakKeptAfterMisses: Readonly<Record<number, number>> = { 1: 0.72, 2: 0.4 };
const toleranceSemitones = 1;
// Nobody voices a note from its first to its last millisecond; this much counts as fully sung.
const fullCoverage = 0.8;
// Streak time pauses across an instrumental gap longer than this instead of counting the silence.
const streakGapSeconds = 4;
// The streak needs this long of good singing to bring the energy ~63% of the way up: about a minute of clean
// singing reaches Legendary, so the show keeps growing through the song instead of maxing out in the first verse.
const streakTimeConstant = 32;
const energyRisePerSecond = 9;
const energyFallPerSecond = 2.6;
const phraseBonusDecayPerSecond = 0.35;
// A forward jump this long is a seek, not a slow frame.
const seekSeconds = 1.5;

/** Quality of one voiced sample, 0–1: exact inside the vibrato band, nothing outside the tolerance. */
export const sampleQuality = (deviation: number): number => {
  const distance = Math.abs(deviation);
  if (distance <= exactSemitones) return 1;
  return Math.max(
    0,
    1 - (distance - exactSemitones) / (toleranceSemitones - exactSemitones),
  );
};

interface NoteProgress {
  evaluated: number;
  absoluteDeviation: number;
  voiced: number;
  matched: number;
  quality: number;
  deviationSum: number;
  deviations: [deviation: number, seconds: number][];
}

const emptyProgress = (): NoteProgress => ({
  evaluated: 0,
  absoluteDeviation: 0,
  voiced: 0,
  matched: 0,
  quality: 0,
  deviationSum: 0,
  deviations: [],
});

const stableSeconds = (progress: NoteProgress, mean: number): number =>
  progress.deviations.reduce((seconds, [deviation, duration]) =>
    seconds + (Math.abs(deviation - mean) <= karaokePitchToleranceSemitones / 2 ? duration : 0), 0);

export const scoreNote = (
  note: ShowNote,
  progress: NoteProgress,
): NoteScore => {
  const duration = Math.max(0.001, scorableNoteDuration(note));
  const voicedCoverage = Math.min(
    1,
    progress.voiced / (duration * fullCoverage),
  );
  const pitchAccuracy =
    progress.voiced > 0 ? progress.quality / progress.voiced : 0;
  const mean = progress.voiced > 0 ? progress.deviationSum / progress.voiced : 0;
  const holdStability = progress.voiced > 0 ? Math.min(1, stableSeconds(progress, mean) / progress.voiced) : 0;
  // The same half-note hit accepted by MelodyRoll must earn the stage's reward.
  const finalScore = Math.min(1, progress.matched / (duration * 0.5));
  return { pitchAccuracy, voicedCoverage, holdStability, finalScore };
};

const finaleGrade = (energy: number, recentScore: number): FinaleGrade => {
  if (energy >= 88 && recentScore >= 0.88) return "legendary";
  if (energy >= 68 && recentScore >= 0.75) return "excellent";
  if (energy >= 40 && recentScore >= 0.6) return "good";
  return "normal";
};

/**
 * Turns the voice into the hidden state of the show: per-note and per-phrase scores, the streak and the
 * Performance Energy (0–100). Driven by the song position, so a pause freezes it and a slower tempo slows it;
 * it never touches audio and never decides what is drawn.
 */
export class PerformanceTracker {
  private notes: readonly ShowNote[] = [];
  private phrases: readonly ShowPhrase[] = [];
  private noteById = new Map<string, ShowNote>();
  private progress = new Map<string, NoteProgress>();
  private archived: { note: ShowNote; progress: NoteProgress }[] = [];
  private rhythmUnion = 0;
  private rhythmIntersection = 0;
  private vocalActivity: readonly (readonly [number, number])[] | undefined;
  private scores = new Map<string, number>();
  private finished = new Set<string>();
  private nextNote = 0;
  private nextPhrase = 0;
  private lastPosition: number | undefined;
  private coveredUntil: number | undefined;
  // Where playback last (re)started: a note already under way there is not judged.
  private seekOrigin = 0;
  private lastGoodAt = -Infinity;
  private misses = 0;
  private goodPhrasesInRow = 0;
  private perfectPhrasesInRow = 0;
  private recent: { at: number; score: number }[] = [];
  private averageScore = 0;
  private phraseBonus = 0;
  private reachedLevel: EnergyLevel = "calm";
  private songDone = false;
  energy = 0;
  streakSeconds = 0;
  live: LiveNote | undefined;

  load(notes: readonly ShowNote[], phrases: readonly ShowPhrase[], resetPerformance = true,
    vocalActivity?: readonly (readonly [number, number])[]): void {
    this.vocalActivity = vocalActivity;
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.phrases = phrases.filter((phrase) => phrase.noteIds.length > 0);
    this.noteById = new Map(this.notes.map((note) => [note.id, note]));
    if (!resetPerformance) return;
    this.energy = 0;
    this.restart(undefined, false);
  }

  get level(): EnergyLevel {
    return energyLevel(this.energy);
  }

  get hitNoteIds(): ReadonlySet<string> {
    return new Set(this.notes.filter((note) => noteHitReached(this.progress.get(note.id)?.matched ?? 0, scorableNoteDuration(note))).map((note) => note.id));
  }

  get noteScore(): KaraokeNoteScore {
    const seen = [...this.archived, ...this.measuredNotes()];
    const sum = (value: (progress: NoteProgress) => number) => seen.reduce((total, { progress }) => total + value(progress), 0);
    const voiced = sum((progress) => progress.voiced);
    const evaluated = sum((progress) => progress.evaluated);
    const mean = voiced > 0 ? sum((progress) => progress.deviationSum) / voiced : 0;
    return {
      version: 1,
      pitchAccuracyPercent: evaluated > 0 ? 100 * Math.min(1, sum((progress) => progress.matched) / evaluated) : 0,
      meanSemitoneDeviation: sum((progress) => progress.absoluteDeviation) / Math.max(0.001, voiced),
      hitNotes: seen.filter(({ note, progress }) => noteHitReached(progress.matched, scorableNoteDuration(note))).length,
      totalNotes: seen.length,
      rhythmAccuracyPercent: this.rhythmUnion > 0 ? 100 * Math.min(1, this.rhythmIntersection / this.rhythmUnion) : 0,
      noteStabilityPercent: voiced > 0 ? 100 * Math.min(1, sum((progress) => stableSeconds(progress, mean)) / voiced) : 0,
    };
  }

  /** Advances to `position` with the voice heard there; returns what the performance just earned. */
  update(position: number, pitchHz: number | undefined, sampleDuration?: number,
    audioActive = pitchHz !== undefined && pitchHz > 0): PerformanceEvent[] {
    if (this.lastPosition === undefined && sampleDuration !== undefined) this.restart(position - sampleDuration / 2);
    const previous = this.lastPosition;
    if (
      previous === undefined ||
      position < previous - 0.05 ||
      position > previous + seekSeconds
    ) {
      this.restart(position);
      return [];
    }
    const elapsed = position - previous;
    this.lastPosition = position;
    if (elapsed <= 0) return [];
    const events: PerformanceEvent[] = [];

    const end = position + (sampleDuration ?? 0) / 2;
    const start = Math.max(sampleDuration === undefined ? previous : position - sampleDuration / 2,
      this.coveredUntil ?? -Infinity);
    this.coveredUntil = end;
    const covered = this.notes.filter((note) => note.start < end && note.end > start);
    let requiredVoice = 0, uncertain = 0;
    this.live = undefined;
    for (const active of covered) {
      const overlap = Math.max(0, Math.min(end, active.end) - Math.max(start, active.start));
      if (overlap === 0) continue;
      const target = targetPitchAt(active, Math.max(active.start, Math.min(active.end, position)));
      const liveMidi = target === undefined ? undefined : pitchMidiNearTarget(pitchHz, target);
      const progress = this.progress.get(active.id) ?? emptyProgress();
      const deviation =
        liveMidi === undefined || target === undefined ? undefined : liveMidi - target;
      const quality = deviation === undefined ? 0 : sampleQuality(deviation);
      if (target !== undefined) {
        progress.evaluated += overlap;
        requiredVoice += overlap;
      } else uncertain += overlap;
      if (deviation !== undefined) {
        progress.absoluteDeviation += Math.abs(deviation) * overlap;
        progress.voiced += overlap;
        if (Math.abs(deviation) <= karaokePitchToleranceSemitones) progress.matched += overlap;
        progress.quality += quality * overlap;
        progress.deviationSum += deviation * overlap;
        progress.deviations.push([deviation, overlap]);
      }
      this.progress.set(active.id, progress);
      const duration = Math.max(0.001, scorableNoteDuration(active));
      this.live = {
        note: active,
        position,
        target: target ?? active.pitch,
        charge: Math.min(1, progress.matched / (duration * 0.5)),
        accuracy: quality,
        deviation,
      };
      if (deviation !== undefined && Math.abs(deviation) <= karaokePitchToleranceSemitones) this.lastGoodAt = position;
    }
    const assessable = Math.max(0, end - start - (this.vocalActivity ? 0 : uncertain));
    if (this.vocalActivity) requiredVoice = this.vocalActivity.reduce((duration, [from, to]) =>
      duration + Math.max(0, Math.min(end, to) - Math.max(start, from)), 0);
    requiredVoice = Math.min(assessable, requiredVoice);
    const sung = audioActive ? assessable : 0;
    this.rhythmUnion += Math.max(requiredVoice, sung);
    this.rhythmIntersection += Math.min(requiredVoice, sung);

    for (
      let note = this.notes[this.nextNote];
      note && note.end < end;
      note = this.notes[this.nextNote]
    ) {
      this.nextNote += 1;
      // A note already under way where playback (re)started was never fully heard, so it is not judged.
      if (note.start < this.seekOrigin) continue;
      const score = scoreNote(
        note,
        this.progress.get(note.id) ?? emptyProgress(),
      );
      this.finishNote(note, score.finalScore, position);
      events.push({ kind: "noteCompleted", note, score });
    }

    for (
      let phrase = this.phrases[this.nextPhrase];
      phrase && phrase.end + 0.15 < position;
      phrase = this.phrases[this.nextPhrase]
    ) {
      this.nextPhrase += 1;
      const event = this.finishPhrase(phrase);
      if (event) events.push(event);
    }

    const singing = position - this.lastGoodAt < streakGapSeconds;
    if (singing && this.misses === 0 && this.lastGoodAt > -Infinity)
      this.streakSeconds += elapsed;
    this.phraseBonus = Math.max(
      0,
      this.phraseBonus - phraseBonusDecayPerSecond * elapsed,
    );
    this.advanceEnergy(elapsed, singing);

    const level = this.level;
    const rank = energyLevels.indexOf(level);
    const reachedRank = energyLevels.indexOf(this.reachedLevel);
    if (rank > reachedRank) {
      this.reachedLevel = level;
      events.push({ kind: "levelReached", level });
    } else if (rank < reachedRank - 1) {
      // Falling two levels lets the show celebrate reaching them again.
      this.reachedLevel = energyLevels[rank + 1] ?? level;
    }

    if (
      !this.songDone &&
      this.phrases.length > 0 &&
      this.nextPhrase >= this.phrases.length
    ) {
      this.songDone = true;
      const recentScore = this.recentScore(position, 20);
      events.push({
        kind: "songCompleted",
        grade: finaleGrade(this.energy, recentScore),
      });
    }
    return events;
  }

  private restart(position: number | undefined, keepScores = true): void {
    this.archived = keepScores ? [...this.archived, ...this.measuredNotes()] : [];
    if (!keepScores) {
      this.rhythmUnion = 0;
      this.rhythmIntersection = 0;
    }
    this.lastPosition = position;
    this.coveredUntil = undefined;
    this.seekOrigin = position ?? 0;
    this.progress.clear();
    this.scores.clear();
    this.finished.clear();
    const from = position ?? 0;
    this.nextNote = this.notes.findIndex((note) => note.end >= from);
    if (this.nextNote < 0) this.nextNote = this.notes.length;
    this.nextPhrase = this.phrases.findIndex(
      (phrase) => phrase.end + 0.15 >= from,
    );
    if (this.nextPhrase < 0) this.nextPhrase = this.phrases.length;
    this.streakSeconds = 0;
    this.misses = 0;
    this.lastGoodAt = -Infinity;
    this.goodPhrasesInRow = 0;
    this.perfectPhrasesInRow = 0;
    this.recent = [];
    this.live = undefined;
    this.songDone = false;
    this.reachedLevel = this.level;
  }

  private measuredNotes(): { note: ShowNote; progress: NoteProgress }[] {
    return this.notes.flatMap((note) => {
      const progress = this.progress.get(note.id);
      return progress && scorableNoteDuration(note) > 0 ? [{ note, progress }] : [];
    });
  }

  private finishNote(note: ShowNote, score: number, position: number): void {
    this.scores.set(note.id, score);
    this.recent.push({ at: position, score });
    if (this.recent.length > 64) this.recent.shift();
    // A short slurred note matters less than a held one, both for the average and for a miss.
    const weight = Math.min(1, 0.35 + (note.end - note.start) / 0.6);
    this.averageScore += (score - this.averageScore) * (1 - Math.exp(-(note.end - note.start) / 2));
    if (score >= goodNoteScore) {
      this.energy = Math.max(20, this.energy);
      this.misses = 0;
      this.lastGoodAt = position;
      return;
    }
    if (weight < 0.6) return;
    // Forgiveness: one miss only dents a long streak; a run of misses lets it go, still gradually.
    this.misses += 1;
    this.streakSeconds *= streakKeptAfterMisses[this.misses] ?? 0;
  }

  private finishPhrase(phrase: ShowPhrase): PerformanceEvent | undefined {
    let weighted = 0;
    let total = 0;
    for (const id of phrase.noteIds) {
      const score = this.scores.get(id);
      const note = this.noteById.get(id);
      if (score === undefined || !note) continue;
      const duration = note.end - note.start;
      weighted += score * duration;
      total += duration;
    }
    if (total === 0) return undefined;
    const score = weighted / total;
    this.goodPhrasesInRow =
      score >= goodPhraseScore ? this.goodPhrasesInRow + 1 : 0;
    this.perfectPhrasesInRow =
      score >= perfectPhraseScore ? this.perfectPhrasesInRow + 1 : 0;
    if (score >= perfectPhraseScore)
      this.phraseBonus = Math.min(10, this.phraseBonus + 4);
    else if (score >= goodPhraseScore)
      this.phraseBonus = Math.min(10, this.phraseBonus + 2);
    return {
      kind: "phraseCompleted",
      score,
      goodInRow: this.goodPhrasesInRow,
      perfectInRow: this.perfectPhrasesInRow,
    };
  }

  private recentScore(position: number, seconds: number): number {
    const window = this.recent.filter(
      (entry) => entry.at >= position - seconds,
    );
    return window.length === 0
      ? 0
      : window.reduce((sum, entry) => sum + entry.score, 0) / window.length;
  }

  private advanceEnergy(elapsed: number, singing: boolean): void {
    const quality = Math.min(1, Math.max(0, (this.averageScore - 0.35) / 0.55));
    const streak = 1 - Math.exp(-this.streakSeconds / streakTimeConstant);
    // Across a long instrumental break the scene holds what was earned and settles only slowly.
    const target =
      singing || this.misses > 0
        ? Math.max(singing ? 25 : 0, Math.min(100, (40 + 60 * streak + this.phraseBonus) * quality))
        : this.energy - 0.25 * elapsed;
    const step = target - this.energy;
    this.energy = Math.max(
      0,
      Math.min(
        100,
        this.energy +
          Math.max(
            -energyFallPerSecond * elapsed,
            Math.min(energyRisePerSecond * elapsed, step),
          ),
      ),
    );
  }
}
