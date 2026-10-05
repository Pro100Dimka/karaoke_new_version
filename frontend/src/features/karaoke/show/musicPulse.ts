import { createPercussionReaction } from "../../../app/backdrop/useSpectrumFeed";

export interface MusicState {
  /** Kick envelope, 0–1. */
  kick: number;
  /** Snare/clap envelope, 0–1. */
  snare: number;
  /** Hi-hat/air activity, 0–1. */
  air: number;
  /** How big the current part of the song is, 0.35 (intro/quiet) – 1.1 (the loudest chorus). */
  intensity: number;
  /** The music has dropped out (a break before a big moment). */
  pause: boolean;
  /** Seconds between beats once a tempo is heard. */
  beatPeriod: number | undefined;
}

export type MusicCue = { kind: "beat"; at: number; strength: number } | { kind: "surge"; at: number };

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const ease = (current: number, target: number, elapsed: number, seconds: number): number =>
  current + (target - current) * (1 - Math.exp(-elapsed / seconds));

const minimumBeatGap = 0.24;
const maximumBeatGap = 1.1;

/**
 * Reads the backing track's spectrum (≈20 frames a second from AudioService) into the musical cues the show
 * releases its rewards on: kick onsets and the tempo between them, the loudness of the current section relative
 * to the loudest part heard so far, breaks and surges. Times are `performance.now()` milliseconds. This is a live
 * heuristic, not a structural analysis: a chorus is recognised as "as loud as the loudest part so far".
 */
export class MusicPulse {
  private percussion = createPercussionReaction();
  private previousKick = 0;
  // Recent kick peak: onsets are judged against this mix's own drums, not an absolute level.
  private kickPeak = 0.05;
  private loudPeak = 0;
  private lastOnset = -Infinity;
  private onsets: number[] = [];
  private fast = 0;
  private medium = 0;
  private airLevel = 0;
  private heard = 0;
  private lastFrame: number | undefined;
  private wasQuiet = false;
  state: MusicState = { kick: 0, snare: 0, air: 0, intensity: 0.35, pause: false, beatPeriod: undefined };

  reset(): void {
    this.percussion = createPercussionReaction();
    this.onsets = [];
    this.lastOnset = -Infinity;
    this.heard = 0;
    this.fast = this.medium = this.loudPeak = 0;
    this.kickPeak = 0.05;
  }

  next(bands: readonly number[], now: number): MusicCue[] {
    const elapsed = this.lastFrame === undefined ? 0.05 : Math.min(0.5, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const cues: MusicCue[] = [];
    const { kick, snare } = this.percussion.next(bands);
    const loudness = average(bands);
    this.heard += elapsed;
    this.fast = ease(this.fast, loudness, elapsed, 0.35);
    this.medium = ease(this.medium, loudness, elapsed, 3);
    this.airLevel = ease(this.airLevel, average(bands.slice(Math.floor(bands.length * 0.7))), elapsed, 0.15);

    const rising = kick - this.previousKick;
    this.previousKick = kick;
    this.kickPeak = Math.max(kick, this.kickPeak * Math.exp(-elapsed / 4), 0.02);
    if (kick > this.kickPeak * 0.45 && rising > this.kickPeak * 0.22 && now - this.lastOnset > minimumBeatGap * 1000) {
      this.onsets.push(now);
      if (this.onsets.length > 17) this.onsets.shift();
      this.lastOnset = now;
      cues.push({ kind: "beat", at: now, strength: Math.min(1, kick / this.kickPeak) });
    }

    // The loudest stretch heard so far stands for the chorus; the current few seconds are measured against it.
    this.loudPeak = Math.max(this.medium, this.loudPeak * Math.exp(-elapsed / 90));
    const lift = this.loudPeak > 0.001 ? this.medium / this.loudPeak : 0;
    const intensity = Math.min(1.1, Math.max(0.35, 0.35 + 0.75 * (lift - 0.55) / 0.4));
    const quiet = this.medium > 0.01 && this.fast < this.medium * 0.42;
    if (this.wasQuiet && this.fast > this.medium * 0.95) cues.push({ kind: "surge", at: now });
    this.wasQuiet = quiet || (this.wasQuiet && this.fast < this.medium * 0.95);

    this.state = {
      kick,
      snare,
      air: Math.min(1, this.airLevel * 3),
      intensity: this.heard < 3 ? 0.35 : intensity,
      pause: quiet,
      beatPeriod: this.beatPeriod()
    };
    return cues;
  }

  /** Milliseconds from `now` to the next expected beat, or undefined while no tempo is heard. */
  untilNextBeat(now: number): number | undefined {
    const period = this.state.beatPeriod;
    if (period === undefined || this.lastOnset === -Infinity) return undefined;
    const periodMs = period * 1000;
    const since = (now - this.lastOnset) % periodMs;
    return periodMs - since;
  }

  private beatPeriod(): number | undefined {
    const gaps = this.onsets.slice(1).map((at, index) => (at - (this.onsets[index] ?? at)) / 1000)
      .filter(gap => gap >= minimumBeatGap && gap <= maximumBeatGap)
      .sort((a, b) => a - b);
    if (gaps.length < 4) return undefined;
    return gaps[Math.floor(gaps.length / 2)];
  }
}
