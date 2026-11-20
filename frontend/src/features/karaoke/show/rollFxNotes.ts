import { easeOutCubic, rgba } from './fxPalette';
import type { ShowNote } from './performanceScoring';
import type { FxCommand } from './visualDirector';
import {
  RollVoicePainter,
  paintCanvas,
  paintContext,
  margin,
  phase,
  sparkleMs,
  glintMs,
  starMs,
  waveMs,
  passMs,
  traceHoldSeconds,
  type PaintCanvas,
  type PaintContext,
  type Geometry,
  type RollView,
  type RollLayout,
  type RollEngine,
  type Moment,
} from './rollFxPaint';
interface Trace {
  t: number;
  q: number;
}
interface ContourTexture {
  canvas: PaintCanvas;
  top: number;
}
export class RollNotePainter {
  private voice: RollVoicePainter;
  constructor(
    private engine: RollEngine,
    private layout: RollLayout,
  ) {
    this.voice = new RollVoicePainter(engine, layout);
  }
  private traces = new Map<string, Trace[]>();
  private sparkles: Moment[] = [];
  private glints: Moment[] = [];
  private stars: Moment[] = [];
  private waves: Moment[] = [];
  private passes: Moment[] = [];
  private contourTextures = new Map<ShowNote, Map<number, ContourTexture>>();
  private contourView: RollView | undefined;
  private contourSize = '';
  onCommand(command: FxCommand): void {
    const moment = {
      start: performance.now(),
      strength: command.strength,
      noteId: command.noteId,
    };
    switch (command.kind) {
      case 'noteGlow':
        if (command.strength >= 0.82) this.sparkles.push(moment);
        if (command.strength >= 0.92) this.glints.push(moment);
        return;
      case 'noteRing':
        this.stars.push(moment);
        return;
      case 'shockwave':
      case 'stageExpansion':
      case 'chargeRelease':
        this.waves.push(moment);
        return;
      case 'laserSweep':
      case 'phraseBloom':
        this.passes.push(moment);
        return;
      default:
        return;
    }
  }
  paint(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
    now: number,
  ): void {
    this.drawHalo(context, view);
    this.drawUpcoming(context, view, geometry);
    this.drawTarget(context, view, geometry);
    this.drawTraces(context, view, geometry);
    this.drawMoments(context, view, geometry, now);
    this.voice.drawVoiceTrail(context, view, geometry);
    this.voice.drawVoice(context, view, geometry, now);
  }
  private drawTarget(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
  ): void {
    const size = `${this.layout.lane.width}:${this.layout.lane.height}:${view.span}:${view.low}:${view.high}`;
    if (this.contourView?.notes !== view.notes || this.contourSize !== size) {
      this.clearContourTextures();
      this.contourView = view;
      this.contourSize = size;
    }
    const scale = context.getTransform().a;
    context.strokeStyle = rgba('white', 0.75);
    context.lineWidth = 1.5;
    for (const note of view.notes) {
      if (!note.contour?.length) continue;
      const left = geometry.x(note.start) - 2;
      const width =
        ((note.end - note.start) * this.layout.lane.width) / view.span + 4;
      if (left > this.layout.lane.width + margin || left + width < margin) {
        this.releaseContourTexture(note);
        continue;
      }
      let textures = this.contourTextures.get(note);
      let texture = textures?.get(scale);
      if (!texture) {
        let top = Infinity;
        let bottom = -Infinity;
        for (const point of note.contour) {
          if ((point[2] ?? 1) < 0.5) continue;
          const y = geometry.y(note.pitch + point[1]);
          top = Math.min(top, y - 2);
          bottom = Math.max(bottom, y + 2);
        }
        if (!Number.isFinite(top)) continue;
        const height = bottom - top;
        // Long notes remain vector paths rather than allocating unbounded textures.
        if (width * scale > 4096 || height * scale > 4096) {
          this.drawContour(context, note, geometry);
          continue;
        }
        const canvas = paintCanvas();
        canvas.width = Math.max(1, Math.ceil(width * scale));
        canvas.height = Math.max(1, Math.ceil(height * scale));
        const brush = paintContext(canvas);
        if (!brush) {
          this.drawContour(context, note, geometry);
          continue;
        }
        brush.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
        brush.strokeStyle = rgba('white', 0.75);
        brush.lineWidth = 1.5;
        this.drawContour(brush, note, geometry);
        texture = { canvas, top };
        if (!textures) {
          textures = new Map();
          this.contourTextures.set(note, textures);
        }
        textures.set(scale, texture);
      }
      context.drawImage(
        texture.canvas,
        left,
        texture.top,
        texture.canvas.width / scale,
        texture.canvas.height / scale,
      );
    }
  }
  private drawContour(
    context: PaintContext,
    note: ShowNote,
    geometry: Geometry,
  ): void {
    context.beginPath();
    let started = false;
    for (const [index, point] of (note.contour ?? []).entries()) {
      if ((point[2] ?? 1) < 0.5) {
        started = false;
        continue;
      }
      const x = geometry.x(note.start + point[0] * (note.end - note.start));
      const y = geometry.y(note.pitch + point[1]);
      if (!started || index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
      started = true;
    }
    context.stroke();
  }
  private releaseContourTexture(note: ShowNote): void {
    const textures = this.contourTextures.get(note);
    if (!textures) return;
    // Offscreen contours are recreated on seek. Release their pixel buffers now
    // instead of retaining every note's two-scale bitmap until the song ends.
    for (const { canvas } of textures.values()) canvas.width = 0;
    this.contourTextures.delete(note);
  }
  private clearContourTextures(): void {
    for (const note of this.contourTextures.keys())
      this.releaseContourTexture(note);
  }
  expire(now: number): void {
    this.sparkles = this.sparkles.filter((m) => now - m.start < sparkleMs);
    this.glints = this.glints.filter((m) => now - m.start < glintMs);
    this.stars = this.stars.filter((m) => now - m.start < starMs);
    this.waves = this.waves.filter((m) => now - m.start < waveMs);
    this.passes = this.passes.filter((m) => now - m.start < passMs);
    this.voice.expire(now);
  }
  record(view: RollView): void {
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
    if ((trace.at(-1)?.t ?? -Infinity) < live.position)
      trace.push({ t: live.position, q: live.accuracy });
    this.traces.set(live.note.id, trace);
  }
  private drawHalo(context: PaintContext, view: RollView): void {
    const glow = this.engine.state.ambient.rollGlow;
    const strength = glow * 0.22;
    if (strength < 0.01) return;
    const x = margin + this.layout.lane.width * view.lead;
    const gradient = context.createLinearGradient(x - 22, 0, x + 22, 0);
    gradient.addColorStop(0, rgba('pink', 0));
    gradient.addColorStop(0.5, rgba('pink', strength));
    gradient.addColorStop(1, rgba('pink', 0));
    context.fillStyle = gradient;
    context.fillRect(x - 22, margin, 44, this.layout.lane.height);
  }
  private drawUpcoming(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
  ): void {
    context.lineWidth = 1.2;
    for (const note of view.notes) {
      const ahead = note.start - view.position;
      if (ahead <= 0 || ahead > 0.6) continue;
      const box = geometry.box(note);
      context.strokeStyle = rgba('white', (1 - ahead / 0.6) * 0.5);
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
  private drawTraces(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
  ): void {
    context.lineCap = 'round';
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
        context.strokeStyle = rgba('magenta', 0.55 * q * fade * flash);
        context.lineWidth = geometry.row * (0.3 + 0.55 * q);
        context.beginPath();
        context.moveTo(geometry.x(a.t), y);
        context.lineTo(geometry.x(b.t), y);
        context.stroke();
        if (q < 0.55) continue;
        context.strokeStyle = rgba(
          'white',
          Math.min(1, (q - 0.45) * 1.6 * fade * flash),
        );
        context.lineWidth = Math.max(1.5, geometry.row * 0.16 * q);
        context.stroke();
      }
    }
  }
  private drawMoments(
    context: PaintContext,
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
    const centerY = margin + this.layout.lane.height / 2;
    const voiceX = margin + this.layout.lane.width * view.lead;
    context.lineWidth = 1.5;
    for (const wave of this.waves) {
      const p = phase(now, wave.start, waveMs);
      const radius = 10 + this.layout.lane.width * 0.6 * easeOutCubic(p);
      context.strokeStyle = rgba(
        'white',
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
      const x = margin - 100 + (this.layout.lane.width + 200) * easeOutCubic(p);
      const gradient = context.createLinearGradient(x - 70, 0, x + 70, 0);
      const alpha = Math.min(1, pass.strength) * Math.sin(Math.PI * p) * 0.28;
      gradient.addColorStop(0, rgba('pink', 0));
      gradient.addColorStop(0.5, rgba('white', alpha));
      gradient.addColorStop(1, rgba('pink', 0));
      context.fillStyle = gradient;
      context.fillRect(x - 70, margin, 140, this.layout.lane.height);
    }
  }
  private star(
    context: PaintContext,
    x: number,
    y: number,
    size: number,
    alpha: number,
  ): void {
    if (alpha <= 0.01) return;
    const core = context.createRadialGradient(x, y, 0, x, y, size);
    core.addColorStop(0, rgba('white', alpha));
    core.addColorStop(0.25, rgba('pink', alpha * 0.55));
    core.addColorStop(1, rgba('pink', 0));
    context.fillStyle = core;
    context.fillRect(x - size, y - size, size * 2, size * 2);
    for (const [horizontal, length] of [
      [true, size * 3],
      [false, size * 1.8],
    ] as const) {
      const streak = horizontal
        ? context.createLinearGradient(x - length, y, x + length, y)
        : context.createLinearGradient(x, y - length, x, y + length);
      streak.addColorStop(0, rgba('white', 0));
      streak.addColorStop(0.5, rgba('white', alpha * 0.9));
      streak.addColorStop(1, rgba('white', 0));
      context.fillStyle = streak;
      if (horizontal) context.fillRect(x - length, y - 0.8, length * 2, 1.6);
      else context.fillRect(x - 0.8, y - length, 1.6, length * 2);
    }
  }
  dispose(): void {
    this.clearContourTextures();
  }
}
