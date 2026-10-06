import type { MusicCue, MusicState } from "./musicPulse";
import {
  goodNoteScore,
  type FinaleGrade,
  type PerformanceEvent,
} from "./performanceTracker";

export type FxKind =
  | "noteGlow"
  | "noteSparks"
  | "noteRing"
  | "chargeRelease"
  | "phraseSweep"
  | "phraseBloom"
  | "crossLight"
  | "lightWave"
  | "stageExpansion"
  | "shockwave"
  | "laserSweep"
  | "firework"
  | "starRain"
  | "dim"
  | "beatPulse";

/** One visual the director allows, at a moment (`performance.now()` ms) and strength (0–1+). */
export interface FxCommand {
  kind: FxKind;
  at: number;
  strength: number;
  /** The completed note the effect belongs to, for effects drawn on it in the melody roll. */
  noteId?: string;
  /** Milliseconds, for effects that last (dimming). */
  duration?: number;
}

export type VisualIntensity = "minimal" | "balanced" | "full";

export interface DirectorContext {
  energy: number;
  streakSeconds: number;
  music: MusicState;
  /** Milliseconds to the next expected beat, when a tempo is heard. */
  untilBeat: number | undefined;
}

const cooldowns: Partial<Record<FxKind, number>> = {
  noteSparks: 600,
  noteRing: 4000,
  chargeRelease: 1500,
  phraseSweep: 1800,
  phraseBloom: 3000,
  crossLight: 8000,
  lightWave: 6000,
  stageExpansion: 20000,
  shockwave: 10000,
  laserSweep: 12000,
  firework: 18000,
  starRain: 9000,
};
const largeKinds: ReadonlySet<FxKind> = new Set([
  "stageExpansion",
  "shockwave",
  "laserSweep",
  "firework",
]);
const flashKinds: ReadonlySet<FxKind> = new Set([
  "laserSweep",
  "firework",
  "shockwave",
  "stageExpansion",
]);
// After a large event only small rewards appear for this long, so one big moment is never buried by the next.
const afterLargeQuietMs = 3000;
const maxLegendarySequences = 2;
const intensityScale: Record<VisualIntensity, number> = {
  minimal: 0.45,
  balanced: 0.75,
  full: 1,
};

/**
 * The single place that decides what is shown: performance events say what was earned, the music says when it is
 * released, the energy and the section say how big it may be, and cooldowns keep the screen from turning into noise.
 * UI components never start effects themselves.
 */
export class VisualDirector {
  private lastAt = new Map<FxKind, number>();
  private pending: FxCommand[] = [];
  private quietUntil = 0;
  private legendaryCount = 0;
  private random: () => number;
  intensity: VisualIntensity = "full";

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  reset(): void {
    this.lastAt.clear();
    this.pending = [];
    this.quietUntil = 0;
    this.legendaryCount = 0;
  }

  /** Plans effects for what just happened and returns every effect whose moment has come. */
  plan(
    now: number,
    events: readonly PerformanceEvent[],
    cues: readonly MusicCue[],
    context: DirectorContext,
  ): FxCommand[] {
    for (const event of events) this.onPerformance(now, event, context);
    for (const cue of cues) this.onMusic(now, cue, context);
    const due = this.pending.filter((command) => command.at <= now);
    this.pending = this.pending.filter((command) => command.at > now);
    const scale = intensityScale[this.intensity];
    return due.map((command) => ({
      ...command,
      strength: command.strength * scale,
    }));
  }

  private ready(kind: FxKind, now: number): boolean {
    if (this.intensity === "minimal" && flashKinds.has(kind)) return false;
    if (largeKinds.has(kind) && now < this.quietUntil) return false;
    return now - (this.lastAt.get(kind) ?? -Infinity) >= (cooldowns[kind] ?? 0);
  }

  private schedule(
    kind: FxKind,
    at: number,
    strength: number,
    extra: Partial<FxCommand> = {},
  ): void {
    this.lastAt.set(kind, at);
    if (largeKinds.has(kind)) this.quietUntil = at + afterLargeQuietMs;
    this.pending.push({ kind, at, strength, ...extra });
  }

  /** The nearest strong musical moment within `maxDelay` ms, else right away: the voice earns it, the music times it. */
  private release(
    from: number,
    context: DirectorContext,
    maxDelay: number,
    now = from,
  ): number {
    const period = (context.music.beatPeriod ?? 0) * 1000;
    if (context.untilBeat === undefined || period <= 0) return from;
    let beat = now + context.untilBeat;
    while (beat < from) beat += period;
    return beat - from <= maxDelay ? beat : from;
  }

  private onPerformance(
    now: number,
    event: PerformanceEvent,
    context: DirectorContext,
  ): void {
    switch (event.kind) {
      case "noteCompleted":
        this.onNote(
          now,
          event.note.id,
          event.note.end - event.note.start,
          event.score.finalScore,
          context,
        );
        return;
      case "phraseCompleted":
        this.onPhrase(
          now,
          event.score,
          event.goodInRow,
          event.perfectInRow,
          context,
        );
        return;
      case "levelReached":
        if (
          ["momentum", "onFire", "headliner", "legendary"].includes(
            event.level,
          ) &&
          this.ready("lightWave", now)
        ) {
          this.schedule(
            "lightWave",
            this.release(now, context, 400),
            context.energy / 100,
          );
        }
        return;
      case "songCompleted":
        this.onFinale(now, event.grade, context);
        return;
    }
  }

  private onNote(
    now: number,
    noteId: string,
    duration: number,
    score: number,
    context: DirectorContext,
  ): void {
    if (score < goodNoteScore) return;
    this.pending.push({ kind: "noteGlow", at: now, strength: score, noteId });
    if (score >= 0.97 && this.ready("noteRing", now)) {
      this.schedule("noteRing", now, 1, { noteId });
    } else if (score >= 0.92 && this.ready("noteSparks", now)) {
      this.schedule("noteSparks", now, 1, { noteId });
    }
    // A long note held nearly perfectly releases its stored charge on the next beat.
    if (
      duration >= 1 &&
      score >= 0.85 &&
      context.energy >= 25 &&
      this.ready("chargeRelease", now)
    ) {
      this.schedule(
        "chargeRelease",
        this.release(now, context, 250),
        Math.min(1, 0.4 + context.energy / 120),
        { noteId },
      );
    }
  }

  private onPhrase(
    now: number,
    score: number,
    goodInRow: number,
    perfectInRow: number,
    context: DirectorContext,
  ): void {
    if (score >= 0.88 && this.ready("phraseBloom", now))
      this.schedule("phraseBloom", now, score);
    else if (score >= 0.7 && this.ready("phraseSweep", now))
      this.schedule("phraseSweep", now, score);
    if (
      goodInRow > 0 &&
      goodInRow % 3 === 0 &&
      context.energy >= 40 &&
      this.ready("crossLight", now)
    ) {
      this.schedule(
        "crossLight",
        this.release(now, context, 500),
        context.energy / 100,
      );
    }
    const bigMoment =
      perfectInRow >= 2 &&
      context.energy >= 60 &&
      context.music.intensity >= 0.85;
    if (!bigMoment) return;
    const at = this.release(now, context, 600);
    if (
      context.energy >= 90 &&
      context.streakSeconds >= 45 &&
      this.legendaryCount < maxLegendarySequences
    ) {
      this.legendary(now, at);
    } else if (context.energy >= 75 && this.ready("laserSweep", now)) {
      this.schedule("laserSweep", at, context.energy / 100);
    } else if (this.ready("shockwave", now)) {
      this.schedule("shockwave", at, 0.6 + context.energy / 250);
    } else if (
      context.energy >= 65 &&
      context.streakSeconds >= 30 &&
      this.ready("firework", now)
    ) {
      this.schedule("firework", at, 0.8);
    }
  }

  private onMusic(now: number, cue: MusicCue, context: DirectorContext): void {
    if (cue.kind === "beat") {
      if (context.energy >= 15)
        this.pending.push({
          kind: "beatPulse",
          at: now,
          strength: (cue.strength * context.energy) / 100,
        });
      // A long strong streak in a big section earns a rare distant firework on the beat.
      if (
        context.streakSeconds >= 30 &&
        context.energy >= 65 &&
        context.music.intensity >= 0.9 &&
        this.ready("firework", now) &&
        this.random() < 0.05
      ) {
        this.schedule("firework", now, 0.7);
      }
      return;
    }
    // A surge after a break is a section change: earned singing opens the stage there.
    if (
      context.energy >= 90 &&
      context.streakSeconds >= 45 &&
      this.legendaryCount < maxLegendarySequences &&
      this.ready("shockwave", now)
    ) {
      this.legendary(now, now + 300);
    } else if (
      context.streakSeconds >= 20 &&
      context.energy >= 55 &&
      this.ready("stageExpansion", now)
    ) {
      this.schedule("dim", now, 0.6, { duration: 300 });
      this.schedule(
        "stageExpansion",
        this.release(now + 300, context, 400, now),
        context.energy / 100,
      );
    }
  }

  /** The rarest staged sequence: a pause, then the effects one after another rather than all at once. */
  private legendary(now: number, at: number): void {
    this.legendaryCount += 1;
    this.pending.push({
      kind: "dim",
      at: now,
      strength: 0.7,
      duration: Math.max(250, at - now),
    });
    this.schedule("shockwave", at, 1.2);
    this.lastAt.set("stageExpansion", at + 200);
    this.pending.push({ kind: "stageExpansion", at: at + 200, strength: 1 });
    this.schedule("starRain", at + 550, 1);
    this.lastAt.set("laserSweep", at + 1100);
    this.pending.push({ kind: "laserSweep", at: at + 1100, strength: 1 });
    this.lastAt.set("firework", at + 2000);
    this.pending.push({ kind: "firework", at: at + 2000, strength: 1 });
    this.quietUntil = at + 2800 + afterLargeQuietMs;
  }

  private onFinale(
    now: number,
    grade: FinaleGrade,
    context: DirectorContext,
  ): void {
    const at = this.release(now, context, 600);
    const push = (
      kind: FxKind,
      offset: number,
      strength: number,
      duration?: number,
    ) => this.pending.push({ kind, at: at + offset, strength, duration });
    switch (grade) {
      case "normal":
        push("phraseBloom", 0, 0.6);
        return;
      case "good":
        push("lightWave", 0, 0.8);
        push("crossLight", 150, 0.8);
        push("starRain", 400, 0.5);
        return;
      case "excellent":
        push("dim", -400, 0.6, 400);
        push("shockwave", 0, 1);
        push("stageExpansion", 200, 1);
        for (const offset of [700, 1300, 2100]) push("firework", offset, 0.9);
        return;
      case "legendary":
        push("dim", -500, 0.8, 500);
        push("shockwave", 0, 1.3);
        push("stageExpansion", 200, 1.2);
        push("starRain", 550, 1.2);
        push("laserSweep", 1100, 1.1);
        for (const offset of [2000, 2400, 2900, 3500, 4200])
          push("firework", offset, 1.1);
        return;
    }
  }
}

export interface Ambient {
  /** Searchlights shown, 0–6 (fractional while one fades in). */
  beams: number;
  /** Rising dust/embers, 0–1. */
  particles: number;
  /** Haze over the clip, 0–1. */
  fog: number;
  /** Video colour lift: saturation/contrast/bloom, 0–1. */
  grade: number;
  /** Melody-roll playhead halo and lane glow, 0–1. */
  rollGlow: number;
  /** Console border glow, 0–1 (kept very soft). */
  consoleGlow: number;
}

/** The long-lived state of the stage for the current energy: it grows with the singer and settles when they stop. */
export const ambientFor = (
  energy: number,
  music: MusicState,
  intensity: VisualIntensity,
): Ambient => {
  const e = Math.max(0, Math.min(1, energy / 100));
  const scale = intensityScale[intensity];
  const section = Math.min(1.15, music.intensity);
  const beams =
    energy < 45
      ? Math.max(0, (energy - 30) / 15) * 2
      : energy < 60
        ? 2
        : energy < 75
          ? 4
          : 6;
  return {
    beams:
      beams *
      Math.min(1, 0.6 + section * 0.45) *
      (intensity === "minimal" ? 0.5 : 1),
    particles: Math.max(0, (e - 0.12) / 0.88) * (0.55 + section * 0.45) * scale,
    fog: Math.max(0, (e - 0.3) / 0.7) * 0.6 * scale,
    grade: e * scale,
    rollGlow: Math.max(0, (e - 0.1) / 0.9),
    consoleGlow: Math.max(0, (e - 0.55) / 0.45) * 0.6,
  };
};
