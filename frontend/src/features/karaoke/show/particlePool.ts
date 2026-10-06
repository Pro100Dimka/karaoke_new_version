import { fxColorNames, light, type FxColor } from "./fxPalette";
import { spriteKind, type LightBatch } from "./gl/lightBatch";

export interface ParticleSpawn {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: FxColor;
  /** Downward acceleration, px/s². */
  gravity?: number;
  /** Fraction of speed kept per second. */
  drag?: number;
  /** Twinkle: brightness flickers. */
  twinkle?: boolean;
}

const fields = 11;
const [X, Y, VX, VY, LIFE, AGE, SIZE, COLOR, GRAVITY, DRAG, TWINKLE] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
] as const;

/** A fixed-size particle store: no allocation while the show runs; when full, new particles are simply skipped. */
export class ParticlePool {
  private data: Float32Array;
  private count = 0;

  constructor(private capacity: number) {
    this.data = new Float32Array(capacity * fields);
  }

  get size(): number {
    return this.count;
  }

  /** Lowers or raises how many particles may live at once (quality scaling). */
  limit(capacity: number): void {
    this.capacity = Math.min(capacity, this.data.length / fields);
    this.count = Math.min(this.count, this.capacity);
  }

  spawn(particle: ParticleSpawn): void {
    if (this.count >= this.capacity) return;
    const at = this.count++ * fields;
    const d = this.data;
    d[at + X] = particle.x;
    d[at + Y] = particle.y;
    d[at + VX] = particle.vx;
    d[at + VY] = particle.vy;
    d[at + LIFE] = particle.life;
    d[at + AGE] = 0;
    d[at + SIZE] = particle.size;
    d[at + COLOR] = fxColorNames.indexOf(particle.color);
    d[at + GRAVITY] = particle.gravity ?? 0;
    d[at + DRAG] = particle.drag ?? 1;
    d[at + TWINKLE] = particle.twinkle ? 1 : 0;
  }

  /** Adds an upward/outward kick to every living particle (a beat pushing the air). */
  push(vy: number): void {
    for (let i = 0; i < this.count; i++)
      this.data[i * fields + VY] = this.read(i * fields + VY) - vy;
  }

  step(elapsed: number): void {
    const d = this.data;
    for (let i = 0; i < this.count;) {
      const at = i * fields;
      const age = this.read(at + AGE) + elapsed;
      if (age >= this.read(at + LIFE)) {
        // Swap-remove keeps the pool dense.
        const last = --this.count * fields;
        d.copyWithin(at, last, last + fields);
        continue;
      }
      const keep = this.read(at + DRAG) ** elapsed;
      const vx = this.read(at + VX) * keep;
      const vy = this.read(at + VY) * keep + this.read(at + GRAVITY) * elapsed;
      d[at + AGE] = age;
      d[at + VX] = vx;
      d[at + VY] = vy;
      d[at + X] = this.read(at + X) + vx * elapsed;
      d[at + Y] = this.read(at + Y) + vy * elapsed;
      i++;
    }
  }

  /** Writes every living particle into the GPU light batch as a small glow. */
  emit(batch: LightBatch, time: number, brightness = 1): void {
    for (let i = 0; i < this.count; i++) {
      const at = i * fields;
      const t = this.read(at + AGE) / Math.max(0.001, this.read(at + LIFE));
      let alpha = Math.min(1, t * 6) * (1 - t) * (1 - t) * brightness;
      if (this.read(at + TWINKLE))
        alpha *= 0.45 + 0.55 * Math.max(0, Math.sin(time * 7 + i * 1.7));
      const color = fxColorNames[this.read(at + COLOR)] ?? "white";
      batch.sprite(
        this.read(at + X),
        this.read(at + Y),
        this.read(at + SIZE) * (1 - t * 0.3),
        spriteKind.glow,
        light(color),
        alpha * 1.4,
      );
    }
  }

  private read(index: number): number {
    return this.data[index] ?? 0;
  }
}
