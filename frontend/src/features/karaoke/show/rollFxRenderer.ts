import { easeOutCubic, rgba } from "./fxPalette";
import { levelProgress, type ShowNote } from "./performanceTracker";
import type { ShowEngine } from "./showEngine";
import type { FxCommand } from "./visualDirector";

/** What the melody roll is showing right now, in the same terms MelodyRoll lays its notes out with. */
export interface RollView {
  notes: readonly ShowNote[];
  position: number;
  /** Seconds across the lane. */
  span: number;
  /** Playhead position across the lane, 0–1. */
  lead: number;
  low: number;
  high: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Geometry {
  row: number;
  x: (seconds: number) => number;
  /** Centre line of a pitch's row, exactly where MelodyRoll centres its capsule. */
  y: (pitch: number) => number;
  box: (note: ShowNote) => Box;
}

/** A moment of the voice on a note: when, and how true it was (0–1). */
interface Trace {
  t: number;
  q: number;
}

interface Moment {
  start: number;
  strength: number;
  noteId?: string;
}

// The overlay reaches this far past the lane so light can spill a little outside it.
const margin = 24;
const sparkleMs = 420;
const glintMs = 380;
const starMs = 700;
const waveMs = 1000;
const passMs = 900;
const burstMs = 600;
/** How far a moment has run, 0–1; frame timestamps can be a hair earlier than the moment itself. */
const phase = (now: number, start: number, duration: number): number =>
  Math.min(1, Math.max(0, (now - start) / duration));

const bloomScale = 0.33;
// A sung trace stays on its note this long after the note has passed, then fades.
const traceHoldSeconds = 2.4;

/**
 * Light inside the melody roll, where the singer is looking. The voice paints the notes it sings with light (hot
 * white where it is true, thinner and pink where it drifts), so every reward is visibly the singer's own; a ring
 * around the voice fills towards the next level of the show; perfect notes catch a glint and a small star. Drawn
 * twice per frame — blurred for bloom, then sharp — and never over the notes' own height, length or position.
 */
export class RollFxRenderer {
  private context: CanvasRenderingContext2D | null;
  // Bloom is made small: the light is drawn at a third of the size, blurred there (cheap) and stretched back.
  private light: HTMLCanvasElement = document.createElement("canvas");
  private lightContext: CanvasRenderingContext2D | null;
  private bloom: HTMLCanvasElement = document.createElement("canvas");
  private bloomContext: CanvasRenderingContext2D | null;
  private frame = 0;
  private last = 0;
  private lane = { left: 0, top: 0, width: 0, height: 0 };
  private page = { left: 0, top: 0 };
  private laneAt = 0;
  private kick = 0;
  private traces = new Map<string, Trace[]>();
  private sparkles: Moment[] = [];
  private glints: Moment[] = [];
  private stars: Moment[] = [];
  private waves: Moment[] = [];
  private passes: Moment[] = [];
  private bursts: Moment[] = [];
  private level = "";
  private unsubscribe: () => void;

  constructor(
    private canvas: HTMLCanvasElement,
    private engine: ShowEngine,
    private frameElement: HTMLElement,
    private view: { current: RollView | undefined },
  ) {
    this.context = canvas.getContext("2d");
    this.lightContext = this.light.getContext("2d");
    this.bloomContext = this.bloom.getContext("2d");
    this.unsubscribe = engine.onCommand((command) => this.onCommand(command));
  }

  start(): void {
    // The next frame is booked first, so one failed frame can never stop the show.
    const tick = (now: number) => {
      this.frame = requestAnimationFrame(tick);
      this.draw(now);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.engine.voicePoint = undefined;
  }

  private onCommand(command: FxCommand): void {
    const moment = {
      start: performance.now(),
      strength: command.strength,
      noteId: command.noteId,
    };
    switch (command.kind) {
      case "beatPulse":
        this.kick = Math.max(this.kick, command.strength);
        return;
      case "noteGlow":
        if (command.strength >= 0.82) this.sparkles.push(moment);
        if (command.strength >= 0.92) this.glints.push(moment);
        return;
      case "noteRing":
        this.stars.push(moment);
        return;
      case "shockwave":
      case "stageExpansion":
      case "chargeRelease":
        this.waves.push(moment);
        return;
      case "laserSweep":
      case "phraseBloom":
        this.passes.push(moment);
        return;
      default:
        return;
    }
  }

  private measureLane(now: number): void {
    if (now - this.laneAt < 250) return;
    this.laneAt = now;
    const lane = this.frameElement
      .querySelector(".ad-melody-roll-lane")
      ?.getBoundingClientRect();
    const frame = this.frameElement.getBoundingClientRect();
    if (!lane || lane.width === 0) return;
    this.lane = {
      left: lane.left - frame.left,
      top: lane.top - frame.top,
      width: lane.width,
      height: lane.height,
    };
    this.page = { left: lane.left - margin, top: lane.top - margin };
    const style = this.canvas.style;
    style.left = `${this.lane.left - margin}px`;
    style.top = `${this.lane.top - margin}px`;
    style.width = `${this.lane.width + margin * 2}px`;
    style.height = `${this.lane.height + margin * 2}px`;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round((this.lane.width + margin * 2) * ratio);
    const height = Math.round((this.lane.height + margin * 2) * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.light.width = this.bloom.width = Math.max(
        1,
        Math.round(width * bloomScale),
      );
      this.light.height = this.bloom.height = Math.max(
        1,
        Math.round(height * bloomScale),
      );
    }
  }

  private geometry(view: RollView): Geometry {
    const { width, height } = this.lane;
    const high = Math.max(view.low + 4, view.high);
    const row = height / (high - view.low + 1);
    const from = view.position - view.span * view.lead;
    return {
      row,
      x: (seconds) => margin + ((seconds - from) / view.span) * width,
      y: (pitch) => margin + (high - pitch) * row + row * 0.5,
      box: (note) => ({
        x: margin + ((note.start - from) / view.span) * width,
        y: margin + (high - note.pitch) * row + row * 0.12,
        width: Math.max(
          width * 0.006,
          ((note.end - note.start) / view.span) * width,
        ),
        height: row * 0.76,
      }),
    };
  }

  private draw(now: number): void {
    const elapsed = Math.min(
      0.05,
      this.last === 0 ? 0.016 : (now - this.last) / 1000,
    );
    this.last = now;
    const context = this.context;
    const small = this.lightContext;
    const blurred = this.bloomContext;
    const view = this.view.current;
    if (!context || !small || !blurred) return;
    this.measureLane(now);
    const fullWidth = this.lane.width + margin * 2;
    const ratio = this.canvas.width / Math.max(1, fullWidth);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.kick *= Math.exp(-elapsed / 0.18);
    this.expire(now);
    if (!view || this.lane.width === 0) return;
    const geometry = this.geometry(view);
    this.record(view);

    // The light once sharp on the overlay, once small for the bloom.
    small.setTransform(1, 0, 0, 1, 0, 0);
    small.clearRect(0, 0, this.light.width, this.light.height);
    for (const [target, scale] of [
      [context, ratio],
      [small, ratio * bloomScale],
    ] as const) {
      target.setTransform(scale, 0, 0, scale, 0, 0);
      target.globalCompositeOperation = "lighter";
      this.paint(target, view, geometry, now);
    }
    blurred.setTransform(1, 0, 0, 1, 0, 0);
    blurred.clearRect(0, 0, this.bloom.width, this.bloom.height);
    blurred.filter = "blur(3px)";
    blurred.drawImage(this.light, 0, 0);
    blurred.filter = "none";
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(this.bloom, 0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(this.bloom, 0, 0, this.canvas.width, this.canvas.height);
    context.globalCompositeOperation = "source-over";
  }

  private paint(
    context: CanvasRenderingContext2D,
    view: RollView,
    geometry: Geometry,
    now: number,
  ): void {
    this.drawHalo(context, view);
    this.drawUpcoming(context, view, geometry);
    this.drawTraces(context, view, geometry);
    this.drawMoments(context, view, geometry, now);
    this.drawVoice(context, view, geometry, now);
  }

  private expire(now: number): void {
    this.sparkles = this.sparkles.filter((m) => now - m.start < sparkleMs);
    this.glints = this.glints.filter((m) => now - m.start < glintMs);
    this.stars = this.stars.filter((m) => now - m.start < starMs);
    this.waves = this.waves.filter((m) => now - m.start < waveMs);
    this.passes = this.passes.filter((m) => now - m.start < passMs);
    this.bursts = this.bursts.filter((m) => now - m.start < burstMs);
  }

  /** Keeps what the voice did on each note; forgets notes long gone and everything after a seek back. */
  private record(view: RollView): void {
    const live = this.engine.state.live;
    for (const [id, trace] of this.traces) {
      const lastT = trace.at(-1)?.t ?? 0;
      if (
        lastT > view.position + 0.2 ||
        lastT < view.position - view.span * view.lead - traceHoldSeconds
      )
        this.traces.delete(id);
    }
    if (!live || live.deviation === undefined || live.accuracy < 0.2) return;
    const trace = this.traces.get(live.note.id) ?? [];
    if ((trace.at(-1)?.t ?? -Infinity) < view.position)
      trace.push({ t: view.position, q: live.accuracy });
    this.traces.set(live.note.id, trace);
  }

  private drawHalo(context: CanvasRenderingContext2D, view: RollView): void {
    const glow = this.engine.state.ambient.rollGlow;
    const strength = glow * 0.22 + this.kick * glow * 0.18;
    if (strength < 0.01) return;
    const x = margin + this.lane.width * view.lead;
    const gradient = context.createLinearGradient(x - 22, 0, x + 22, 0);
    gradient.addColorStop(0, rgba("pink", 0));
    gradient.addColorStop(0.5, rgba("pink", strength));
    gradient.addColorStop(1, rgba("pink", 0));
    context.fillStyle = gradient;
    context.fillRect(x - 22, margin, 44, this.lane.height);
  }

  /** A note about to reach the playhead is outlined softly, to help the singer prepare to enter it. */
  private drawUpcoming(
    context: CanvasRenderingContext2D,
    view: RollView,
    geometry: Geometry,
  ): void {
    context.lineWidth = 1.2;
    for (const note of view.notes) {
      const ahead = note.start - view.position;
      if (ahead <= 0 || ahead > 0.6) continue;
      const box = geometry.box(note);
      context.strokeStyle = rgba("white", (1 - ahead / 0.6) * 0.5);
      context.beginPath();
      context.roundRect(
        box.x - 1.5,
        box.y - 1.5,
        box.width + 3,
        box.height + 3,
        (box.height + 3) / 2,
      );
      context.stroke();
    }
  }

  /** The voice's light on the notes: thick and white-hot where it was true, thin and pink where it drifted. */
  private drawTraces(
    context: CanvasRenderingContext2D,
    view: RollView,
    geometry: Geometry,
  ): void {
    context.lineCap = "round";
    for (const note of view.notes) {
      const trace = this.traces.get(note.id);
      if (!trace || trace.length < 2) continue;
      const y = geometry.y(note.pitch);
      const fade = Math.exp(
        -Math.max(0, view.position - note.end) / traceHoldSeconds,
      );
      const flash = this.sparkles.some((m) => m.noteId === note.id) ? 1.6 : 1;
      for (let i = 1; i < trace.length; i++) {
        const a = trace[i - 1];
        const b = trace[i];
        if (!a || !b || b.t - a.t > 0.15) continue;
        const q = (a.q + b.q) / 2;
        context.strokeStyle = rgba("magenta", 0.55 * q * fade * flash);
        context.lineWidth = geometry.row * (0.3 + 0.55 * q);
        context.beginPath();
        context.moveTo(geometry.x(a.t), y);
        context.lineTo(geometry.x(b.t), y);
        context.stroke();
        if (q < 0.55) continue;
        context.strokeStyle = rgba(
          "white",
          Math.min(1, (q - 0.45) * 1.6 * fade * flash),
        );
        context.lineWidth = Math.max(1.5, geometry.row * 0.16 * q);
        context.stroke();
      }
    }
  }

  private drawMoments(
    context: CanvasRenderingContext2D,
    view: RollView,
    geometry: Geometry,
    now: number,
  ): void {
    const note = (id: string | undefined) =>
      id ? view.notes.find((candidate) => candidate.id === id) : undefined;
    // Perfect: a glint runs along the note, ending in a small star.
    for (const glint of this.glints) {
      const target = note(glint.noteId);
      if (!target) continue;
      const box = geometry.box(target);
      const p = phase(now, glint.start, glintMs);
      this.star(
        context,
        box.x + box.width * easeOutCubic(p),
        box.y + box.height / 2,
        geometry.row * (1.2 + p),
        1 - p * 0.6,
      );
    }
    // Exceptional (rare): a bigger star with long glare at the end of the note.
    for (const star of this.stars) {
      const target = note(star.noteId);
      if (!target) continue;
      const box = geometry.box(target);
      const p = phase(now, star.start, starMs);
      this.star(
        context,
        box.x + box.width,
        box.y + box.height / 2,
        geometry.row * (2.2 + 1.5 * easeOutCubic(p)),
        (1 - p) ** 1.4 * 1.3,
      );
    }
    const centerY = margin + this.lane.height / 2;
    const voiceX = margin + this.lane.width * view.lead;
    context.lineWidth = 1.5;
    for (const wave of this.waves) {
      const p = phase(now, wave.start, waveMs);
      const radius = 10 + this.lane.width * 0.6 * easeOutCubic(p);
      context.strokeStyle = rgba(
        "white",
        Math.min(1, wave.strength) * (1 - p) ** 1.5 * 0.7,
      );
      context.beginPath();
      context.ellipse(
        voiceX,
        centerY,
        radius,
        radius * 0.45,
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
    }
    for (const pass of this.passes) {
      const p = phase(now, pass.start, passMs);
      const x = margin - 100 + (this.lane.width + 200) * easeOutCubic(p);
      const gradient = context.createLinearGradient(x - 70, 0, x + 70, 0);
      const alpha = Math.min(1, pass.strength) * Math.sin(Math.PI * p) * 0.28;
      gradient.addColorStop(0, rgba("pink", 0));
      gradient.addColorStop(0.5, rgba("white", alpha));
      gradient.addColorStop(1, rgba("pink", 0));
      context.fillStyle = gradient;
      context.fillRect(x - 70, margin, 140, this.lane.height);
    }
  }

  /** A four-point star: hot core, soft glow and the two glare streaks of a bright light. */
  private star(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    alpha: number,
  ): void {
    if (alpha <= 0.01) return;
    const core = context.createRadialGradient(x, y, 0, x, y, size);
    core.addColorStop(0, rgba("white", alpha));
    core.addColorStop(0.25, rgba("pink", alpha * 0.55));
    core.addColorStop(1, rgba("pink", 0));
    context.fillStyle = core;
    context.fillRect(x - size, y - size, size * 2, size * 2);
    for (const [horizontal, length] of [
      [true, size * 3],
      [false, size * 1.8],
    ] as const) {
      const streak = horizontal
        ? context.createLinearGradient(x - length, y, x + length, y)
        : context.createLinearGradient(x, y - length, x, y + length);
      streak.addColorStop(0, rgba("white", 0));
      streak.addColorStop(0.5, rgba("white", alpha * 0.9));
      streak.addColorStop(1, rgba("white", 0));
      context.fillStyle = streak;
      if (horizontal) context.fillRect(x - length, y - 0.8, length * 2, 1.6);
      else context.fillRect(x - 0.8, y - length, 1.6, length * 2);
    }
  }

  /**
   * The voice itself: a white-hot point where it is true, and around it a thin ring that fills towards the next
   * level of the show — visible progress makes the next reward feel within reach.
   */
  private drawVoice(
    context: CanvasRenderingContext2D,
    view: RollView,
    geometry: Geometry,
    now: number,
  ): void {
    const state = this.engine.state;
    const x = margin + this.lane.width * view.lead;
    const live = state.live;
    const y = live
      ? geometry.y(live.note.pitch) -
        Math.max(-1, Math.min(1, live.deviation ?? 0)) * geometry.row
      : margin + this.lane.height / 2;
    this.engine.voicePoint = { x: this.page.left + x, y: this.page.top + y };
    if (state.level !== this.level) {
      if (this.level !== "" && state.energy > 1)
        this.bursts.push({ start: now, strength: 1 });
      this.level = state.level;
    }
    if (!state.playing) return;
    const radius = Math.max(15, geometry.row * 1.25);
    const accuracy = live?.deviation === undefined ? 0 : live.accuracy;
    if (accuracy > 0.2) {
      const core = context.createRadialGradient(x, y, 0, x, y, radius * 1.4);
      core.addColorStop(0, rgba("white", accuracy));
      core.addColorStop(0.18, rgba("pink", accuracy * 0.7));
      core.addColorStop(1, rgba("magenta", 0));
      context.fillStyle = core;
      context.fillRect(
        x - radius * 1.4,
        y - radius * 1.4,
        radius * 2.8,
        radius * 2.8,
      );
    }
    // The ring: a faint track and the filled share of the way to the next level.
    const ringAlpha = live ? 0.9 : 0.45;
    context.lineWidth = 1.6;
    context.strokeStyle = rgba("white", 0.12 * ringAlpha);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = rgba("pink", 0.85 * ringAlpha);
    context.beginPath();
    context.arc(
      x,
      y,
      radius,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * levelProgress(state.energy),
    );
    context.stroke();
    for (const burst of this.bursts) {
      const p = phase(now, burst.start, burstMs);
      context.strokeStyle = rgba("white", (1 - p) ** 1.5);
      context.lineWidth = 2.5 * (1 - p) + 0.5;
      context.beginPath();
      context.arc(x, y, radius * (1 + 1.8 * easeOutCubic(p)), 0, Math.PI * 2);
      context.stroke();
    }
  }
}
