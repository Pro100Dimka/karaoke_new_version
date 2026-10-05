import { spriteKind, type LightBatch, type Rgb } from "./gl/lightBatch";

/**
 * How the lights move together. A designed look per moment, never random motion: resting light leaning in, a
 * fan opening outwards, pairs crossing, all converging on a point, or a tight unison sweep.
 */
export type Cue = "rest" | "fan" | "cross" | "focus" | "sweep";

interface Fixture {
  x: number;
  side: 1 | -1;
  color: Rgb;
  tilt: number;
  velocity: number;
  /** 0–1: how lit the fixture is; it powers on only when the singer's light reaches it. */
  power: number;
  on: boolean;
  /** The flash of the lamp powering on, decaying. */
  ignition: number;
}

const magenta: Rgb = [1, 0.2, 0.55];
const blush: Rgb = [1, 0.62, 0.84];
const cyan: Rgb = [0.25, 0.85, 1];
const white: Rgb = [1, 0.95, 0.97];

// Unlock order: the outer pink pair, then the soft white-pink centre pair, then the cyan wings.
const layout = [
  { x: 0.22, color: magenta },
  { x: 0.78, color: magenta },
  { x: 0.4, color: blush },
  { x: 0.6, color: blush },
  { x: 0.06, color: cyan },
  { x: 0.94, color: cyan },
] as const;

const lampHeight = -18;
// A critically damped spring: the heads glide to each new look and settle without wobble.
const stiffness = 14;
const damping = 2 * Math.sqrt(stiffness);

export interface RigLook {
  kick: number;
  flash: number;
  expansion: number;
}

export class StageRig {
  readonly fixtures: Fixture[] = layout.map(({ x, color }) => ({
    x, side: x < 0.5 ? 1 : -1, color, tilt: (x < 0.5 ? 1 : -1) * 0.24, velocity: 0, power: 0, on: false, ignition: 0,
  }));
  private cue: Cue = "rest";
  private cueUntil = 0;
  private focus = { x: 0, y: 0 };

  /** Shows a look for `duration` ms, then returns to rest. */
  setCue(cue: Cue, now: number, duration: number, focus?: { x: number; y: number }): void {
    this.cue = cue;
    this.cueUntil = now + duration;
    if (focus) this.focus = focus;
  }

  /** Where a fixture hangs, in CSS pixels. */
  lamp(index: number, width: number): { x: number; y: number } {
    return { x: (this.fixtures[index]?.x ?? 0.5) * width, y: lampHeight };
  }

  powerOn(index: number): void {
    const fixture = this.fixtures[index];
    if (!fixture || fixture.on) return;
    fixture.on = true;
    fixture.ignition = 1;
  }

  /** Fixtures beyond what the energy holds dim slowly and go out. */
  powerDown(from: number): void {
    this.fixtures.forEach((fixture, index) => {
      if (index >= from) fixture.on = false;
    });
  }

  /** A big moment: every lit lamp flares at once. */
  ignite(amount: number): void {
    for (const fixture of this.fixtures) fixture.ignition = Math.max(fixture.ignition, fixture.power * amount);
  }

  update(elapsed: number, now: number, time: number, width: number, motion: boolean): void {
    if (now > this.cueUntil) this.cue = "rest";
    const cue = motion ? this.cue : this.cue === "sweep" || this.cue === "fan" ? "rest" : this.cue;
    this.fixtures.forEach((fixture, i) => {
      const target = this.targetTilt(fixture, i, cue, time, width, motion);
      const acceleration = stiffness * (target - fixture.tilt) - damping * fixture.velocity;
      fixture.velocity += acceleration * elapsed;
      fixture.tilt += fixture.velocity * elapsed;
      fixture.power = Math.max(0, Math.min(1, fixture.power + (fixture.on ? elapsed / 0.9 : -elapsed / 3.5)));
      fixture.ignition *= Math.exp(-elapsed / 0.45);
    });
  }

  private targetTilt(fixture: Fixture, index: number, cue: Cue, time: number, width: number, motion: boolean): number {
    const breathe = motion ? 0.07 * Math.sin(time * 0.21 + index * 1.3) : 0;
    switch (cue) {
      case "rest":
        return fixture.side * 0.24 + breathe;
      case "fan":
        return (fixture.x - 0.5) * 1.6;
      case "cross":
        return -fixture.side * 0.46 + breathe * 0.5;
      case "focus":
        return Math.atan2(this.focus.x - fixture.x * width, Math.max(40, this.focus.y - lampHeight)) + breathe * 0.2;
      case "sweep":
        return 0.7 * Math.sin(time * 1.5);
    }
  }

  draw(batch: LightBatch, width: number, height: number, look: RigLook): void {
    const length = Math.hypot(width, height) * 1.1;
    const narrow = this.cue === "sweep";
    for (const fixture of this.fixtures) {
      if (fixture.power <= 0.005) continue;
      const x = fixture.x * width;
      const color = look.expansion > 0.3 || fixture.ignition > 0.4 ? mix(fixture.color, white, Math.max(look.expansion, fixture.ignition) * 0.6) : fixture.color;
      const level = fixture.power * (0.4 + 0.16 * look.kick + 0.5 * look.flash + 0.45 * look.expansion + 0.6 * fixture.ignition) * (narrow ? 1.7 : 1);
      const spread = narrow ? 0.035 : 0.095 + 0.04 * look.expansion;
      batch.beam(x, lampHeight, Math.PI - fixture.tilt, spread, length, color, level);
      // The lamp itself: a hot lens with the eye's glare streaks.
      batch.sprite(x, 4, 120, spriteKind.flare, color, fixture.power * (0.55 + 0.35 * look.kick) + fixture.ignition * 3, 0.9);
      batch.sprite(x, 4, 46, spriteKind.glow, white, fixture.power * 0.6 + fixture.ignition * 2);
    }
  }
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
