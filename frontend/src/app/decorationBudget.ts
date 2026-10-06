/** Measures sustained UI frame starvation, not one slow dialog entrance or IPC reply. */
export class DecorationBudget {
  private warming = true;
  private elapsed = 0;
  private samples: number[] = [];
  private limited = false;

  resetTiming() {
    this.warming = true;
    this.elapsed = 0;
    this.samples = [];
  }

  sample(milliseconds: number): boolean {
    if (this.limited) return true;
    // Chromium can throttle occluded windows to one frame per second.
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return false;
    if (milliseconds >= 900) { this.resetTiming(); return false; }
    this.elapsed += milliseconds;
    if (!this.warming) this.samples.push(milliseconds);
    if (this.elapsed < 2000) return false;
    this.elapsed = 0;
    if (this.warming) { this.warming = false; return false; }
    this.samples.sort((a, b) => a - b);
    this.limited = this.samples[Math.floor(this.samples.length / 2)]! > 28;
    this.samples = [];
    // Keep the lighter mode for this session: retrying heavy effects recreates the stall.
    return this.limited;
  }
}
