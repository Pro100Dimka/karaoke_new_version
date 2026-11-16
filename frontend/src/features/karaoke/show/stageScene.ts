import { approach, light, type FxColor } from './fxPalette';
import { LightBatch, spriteKind, type Rgb } from './gl/lightBatch';
import { ParticlePool } from './particlePool';
import type { ShowEngine } from './showEngine';
import type { FxCommand } from './visualDirector';
interface Timed {
  start: number;
  duration: number;
  strength: number;
}
interface Ring extends Timed {
  x: number;
  y: number;
  radius: number;
  color: Rgb;
}
interface Flare extends Timed {
  x: number;
  y: number;
  size: number;
  color: Rgb;
}
interface Anchors {
  lyrics?: DOMRect;
  roll?: DOMRect;
  rollPanel?: DOMRect;
  consoleVisible: boolean;
}
export const particleBudgets = [220, 380, 560, 760] as const;
const white: Rgb = [1, 0.96, 0.98];
const pink: Rgb = [1, 0.3, 0.62];
const gold: Rgb = [1, 0.8, 0.5];
const violet: Rgb = [0.6, 0.4, 1];
const progress = (item: Timed, now: number): number =>
  Math.max(0, (now - item.start) / item.duration);
const alive = <T extends Timed>(items: T[], now: number): T[] =>
  items.filter((item) => progress(item, now) < 1);
const random = (from: number, to: number): number =>
  from + Math.random() * (to - from);
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

export interface StageLayout {
  width: number;
  height: number;
  anchors: Anchors;
}
export class StageScene {
  constructor(
    private engine: ShowEngine,
    private layout: StageLayout,
    private onSweep: () => void,
  ) {}
  readonly pool = new ParticlePool(particleBudgets[3]);
  private grade = 0;
  private rings: Ring[] = [];
  private flares: Flare[] = [];
  private rain: Timed | undefined;
  private rainDebt = 0;
  private get motion(): boolean {
    return !this.engine.state.settings.reducedMotion;
  }
  private voice(): { x: number; y: number } {
    const point = this.engine.voicePoint;
    if (point) return point;
    const roll = this.layout.anchors.roll;
    if (roll)
      return {
        x: roll.left + roll.width * 0.25,
        y: roll.top + roll.height / 2,
      };
    const lyrics = this.layout.anchors.lyrics;
    return lyrics
      ? { x: lyrics.left + lyrics.width / 2, y: lyrics.top + lyrics.height / 2 }
      : { x: this.layout.width / 2, y: this.layout.height / 2 };
  }
  onCommand(command: FxCommand): void {
    const now = performance.now();
    const s = command.strength;
    const voice = this.voice();
    const reach =
      Math.hypot(this.layout.width, this.layout.height) *
      (this.layout.anchors.consoleVisible ? 0.6 : 0.75);
    switch (command.kind) {
      case 'beatPulse':
      case 'noteGlow':
      case 'phraseSweep':
      case 'crossLight':
      case 'laserSweep':
      case 'lightWave':
        return;
      case 'chargeRelease':
        this.rings.push({
          x: voice.x,
          y: voice.y,
          radius: 240,
          color: pink,
          start: now,
          duration: 900,
          strength: s,
        });
        this.flares.push({
          x: voice.x,
          y: voice.y,
          size: 150,
          color: white,
          start: now,
          duration: 600,
          strength: 1.4 * s,
        });
        this.burst(voice.x, voice.y, 16 * s, 140, ['pink', 'white']);
        return;
      case 'phraseBloom':
        this.onSweep();
        return;
      case 'stageExpansion':
        this.rings.push({
          x: this.layout.width / 2,
          y: this.layout.height + 40,
          radius: reach * 1.2,
          color: violet,
          start: now,
          duration: 1600,
          strength: s * 0.8,
        });
        this.burst(
          this.layout.width / 2,
          this.layout.height,
          60 * s,
          420,
          ['pink', 'white', 'violet', 'gold'],
          true,
        );
        return;
      case 'shockwave':
        this.rings.push({
          x: voice.x,
          y: voice.y,
          radius: this.motion ? reach : reach * 0.3,
          color: pink,
          start: now,
          duration: 1300,
          strength: s,
        });
        this.flares.push({
          x: voice.x,
          y: voice.y,
          size: 260,
          color: white,
          start: now,
          duration: 700,
          strength: 1.8 * s,
        });
        return;
      case 'firework':
        this.starburst(s);
        return;
      case 'starRain':
        this.rain = { start: now, duration: 3200, strength: s };
        return;
      case 'noteSparks':
      case 'noteRing':
        // Drawn on the note itself by the melody roll's own layer.
        return;
    }
  }
  private burst(
    x: number,
    y: number,
    count: number,
    speed: number,
    colors: readonly FxColor[],
    upward = false,
  ): void {
    const motion = this.motion ? 1 : 0.3;
    for (let i = 0; i < count; i++) {
      const angle = upward
        ? random(-Math.PI * 0.92, -Math.PI * 0.08)
        : random(0, Math.PI * 2);
      const velocity = random(0.3, 1) * speed * motion;
      this.pool.spawn({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life: random(0.9, 1.8),
        size: random(5, 11),
        color: colors[i % colors.length] ?? 'white',
        gravity: 60,
        drag: 0.3,
        twinkle: i % 3 === 0,
      });
    }
  }
  private starburst(strength: number): void {
    const { x, y } = this.distantSpot();
    const now = performance.now();
    const palettes = [
      ['gold', 'white'],
      ['pink', 'white'],
      ['violet', 'pink'],
      ['cyan', 'white'],
    ] as const;
    const palette =
      palettes[Math.floor(Math.random() * palettes.length)] ?? palettes[0];
    this.flares.push({
      x,
      y,
      size: 220 * strength,
      color: light(palette[0]),
      start: now,
      duration: 1100,
      strength: 2.2 * strength,
    });
    if (!this.motion) return;
    const count = Math.round(70 * strength);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + random(-0.06, 0.06);
      const velocity = random(60, 170) * strength;
      this.pool.spawn({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life: random(1.6, 2.8),
        size: random(4, 8),
        color: i % 3 === 0 ? palette[1] : palette[0],
        gravity: 38,
        drag: 0.4,
        twinkle: i % 2 === 0,
      });
    }
  }
  private distantSpot(): { x: number; y: number } {
    const { width: w, height: h } = this.layout;
    const panel = this.layout.anchors.rollPanel;
    if (!panel || panel.top > h * 0.16)
      return {
        x: random(0.15, 0.85) * w,
        y: random(0.05, Math.min(0.18, (panel?.top ?? h * 0.3) / h - 0.04)) * h,
      };
    const left = panel.left;
    const right = w - panel.right;
    if (Math.max(left, right) > w * 0.08) {
      const onLeft = left >= right;
      return {
        x: onLeft
          ? random(0.25, 0.75) * left
          : panel.right + random(0.25, 0.75) * right,
        y: random(0.1, 0.45) * h,
      };
    }
    return { x: random(0.1, 0.9) * w, y: random(0.02, 0.08) * h };
  }
  private spawnRain(elapsed: number): void {
    if (!this.rain) return;
    this.rainDebt += this.rain.strength * 34 * elapsed;
    while (this.rainDebt >= 1) {
      this.rainDebt -= 1;
      this.pool.spawn({
        x: random(0, this.layout.width),
        y: random(-20, this.layout.height * 0.08),
        vx: random(-6, 6),
        vy: random(30, 80) * (this.motion ? 1 : 0.4),
        life: random(3, 4.5),
        size: random(3, 6),
        color: Math.random() < 0.5 ? 'white' : 'gold',
        twinkle: true,
      });
    }
  }
  private drawBokeh(batch: LightBatch, time: number): void {
    const amount = Math.max(0, (this.grade - 0.45) / 0.55);
    if (amount < 0.01) return;
    const colors: Rgb[] = [pink, violet, [0.3, 0.8, 1], gold, pink, violet];
    for (const [i, color] of colors.entries()) {
      const drift = this.motion ? time * (0.008 + i * 0.002) : 0;
      const x = ((i * 0.173 + drift + 0.05) % 1) * this.layout.width;
      const y = this.layout.height * (0.12 + ((i * 0.41) % 0.8));
      batch.sprite(
        x,
        y,
        50 + (i % 3) * 30,
        spriteKind.bokeh,
        color,
        amount * (0.07 + 0.03 * Math.sin(time * 0.6 + i)),
      );
    }
  }
  advance(now: number, elapsed: number): void {
    const state = this.engine.state;

    this.grade = approach(
      this.grade,
      state.ambient.grade,
      elapsed,
      state.ambient.grade > this.grade ? 1.6 : 3.5,
    );
    this.rings = alive(this.rings, now);
    this.flares = alive(this.flares, now);
    if (this.rain && progress(this.rain, now) >= 1) this.rain = undefined;
    this.spawnRain(elapsed);
    this.pool.step(elapsed);
  }
  paint(batch: LightBatch, now: number): void {
    const time = now / 1000;
    this.drawBokeh(batch, time);
    for (const ring of this.rings) {
      const p = progress(ring, now);
      const radius = ring.radius * easeOut(p);
      batch.sprite(
        ring.x,
        ring.y,
        radius + 60,
        spriteKind.ring,
        ring.color,
        ring.strength * (1 - p) ** 1.5 * 1.6,
        radius / (radius + 60),
        0.035 + 0.05 * (1 - p),
      );
    }
    for (const flare of this.flares) {
      const p = progress(flare, now);
      batch.sprite(
        flare.x,
        flare.y,
        flare.size * (0.8 + 0.4 * easeOut(p)),
        spriteKind.flare,
        flare.color,
        flare.strength * (1 - p) ** 2,
        1.1,
      );
    }
    this.pool.emit(batch, time);
  }
}
