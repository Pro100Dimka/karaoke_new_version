/** Bound both vertex work and fullscreen postprocessing, which scales with pixel area. */
export const backdropBudgets = [
  { particles: 600, secondaryParticles: 2000, resolutionScale: 0.5 },
  { particles: 1200, secondaryParticles: 4000, resolutionScale: 0.65 },
  { particles: 2400, secondaryParticles: 8000, resolutionScale: 0.8 },
  { particles: 4250, secondaryParticles: 14000, resolutionScale: 1 },
] as const;

/** Adapt to measured render cadence, never to device names or browser RAM estimates. */
export class BackdropQuality {
  /** `frameMs`: the interval the backdrop aims for; slow and smooth are judged against it. */
  constructor(private readonly frameMs = 1000 / 60) {}

  private level = 1;
  private ceiling = backdropBudgets.length - 1;
  private samples: number[] = [];
  private elapsed = 0;
  private stableWindows = 0;
  private warming = true;

  get budget() {
    return backdropBudgets[this.level]!;
  }

  resetTiming() {
    this.samples = [];
    this.elapsed = 0;
    this.stableWindows = 0;
    this.warming = true;
  }

  sample(milliseconds: number): boolean {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return false;
    // A long suspension says nothing about steady-state rendering capacity.
    if (milliseconds > 1000) {
      this.resetTiming();
      return false;
    }
    this.samples.push(milliseconds);
    this.elapsed += milliseconds;
    if (this.elapsed < 2000) return false;
    const sorted = this.samples.sort((a, b) => a - b);
    // At a 30 Hz target, 50 ms already means a sustained drop to 20 Hz.
    const slow = sorted[Math.floor(sorted.length * 0.75)]! > this.frameMs * 1.25;
    const smooth =
      sorted[Math.floor(sorted.length * 0.9)]! < this.frameMs * 1.14;
    this.samples = [];
    this.elapsed = 0;
    if (this.warming) {
      this.warming = false;
      return false;
    }
    const previous = this.level;
    if (slow) {
      this.level = Math.max(0, this.level - 1);
      // Do not repeatedly reallocate GPU targets and re-enable expensive effects
      // after already measuring that this window cannot sustain the next level.
      this.ceiling = this.level;
      this.stableWindows = 0;
    } else if (smooth) {
      if (++this.stableWindows >= 4) {
        this.level = Math.min(this.ceiling, this.level + 1);
        this.stableWindows = 0;
      }
    } else {
      this.stableWindows = 0;
    }
    if (previous !== this.level) this.warming = true;
    return previous !== this.level;
  }
}
