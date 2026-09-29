export const backdropBudgets = [
  { particles: 600, secondaryParticles: 6000 },
  { particles: 1200, secondaryParticles: 12000 },
  { particles: 2400, secondaryParticles: 25000 },
  { particles: 4250, secondaryParticles: 50000 },
] as const;

/** Adapt to measured render cadence, never to device names or browser RAM estimates. */
export class BackdropQuality {
  private level = 1;
  private samples: number[] = [];
  private elapsed = 0;
  private stableWindows = 0;
  private warming = true;

  get budget() { return backdropBudgets[this.level]!; }

  resetTiming() {
    this.samples = [];
    this.elapsed = 0;
    this.stableWindows = 0;
    this.warming = true;
  }

  sample(milliseconds: number): boolean {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return false;
    // A long suspension says nothing about steady-state rendering capacity.
    if (milliseconds > 1000) { this.resetTiming(); return false; }
    this.samples.push(milliseconds);
    this.elapsed += milliseconds;
    if (this.elapsed < 2000) return false;
    const sorted = this.samples.sort((a, b) => a - b);
    const slow = sorted[Math.floor(sorted.length * 0.75)]! > 25;
    const smooth = sorted[Math.floor(sorted.length * 0.9)]! < 19;
    this.samples = [];
    this.elapsed = 0;
    if (this.warming) { this.warming = false; return false; }
    const previous = this.level;
    if (slow) {
      this.level = Math.max(0, this.level - 1);
      this.stableWindows = 0;
    } else if (smooth) {
      if (++this.stableWindows >= 4) {
        this.level = Math.min(backdropBudgets.length - 1, this.level + 1);
        this.stableWindows = 0;
      }
    } else {
      this.stableWindows = 0;
    }
    if (previous !== this.level) this.warming = true;
    return previous !== this.level;
  }
}
