import { approach, easeOutCubic, rgba } from './fxPalette';
import { levelProgress, type ShowNote } from './performanceTracker';
import type { ShowEngine } from './showEngine';
import type { FxCommand } from './visualDirector';
import { pitchHzToMidi, reliablePitchHz } from '../karaokeLyrics';

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

type PaintContext =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type PaintCanvas = HTMLCanvasElement | OffscreenCanvas;
export type RollEngine = Pick<
  ShowEngine,
  'state' | 'voiceHistory' | 'voicePoint' | 'onCommand'
>;
interface RollLayout {
  lane: { left: number; top: number; width: number; height: number };
  page: { left: number; top: number };
  ratio: number;
  glow?: { width: number; height: number; radius: number[]; blur: number };
}
export interface RollFrame {
  type: 'frame';
  now: number;
  layout?: RollLayout;
  state: ShowEngine['state'];
  history: ShowEngine['voiceHistory'];
  resetHistory: boolean;
  historyFrom: number;
  view: (Omit<RollView, 'notes'> & { notes?: readonly ShowNote[] }) | undefined;
  commands: FxCommand[];
}
const paintCanvas = (): PaintCanvas =>
  typeof document === 'undefined'
    ? new OffscreenCanvas(1, 1)
    : document.createElement('canvas');

interface ContourTexture {
  canvas: PaintCanvas;
  top: number;
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
  private context: PaintContext | null;
  // Bloom is made small: the light is drawn at a third of the size, blurred there (cheap) and stretched back.
  private light = paintCanvas();
  private lightContext: PaintContext | null;
  private bloom = paintCanvas();
  private bloomContext: PaintContext | null;
  private worker: Worker | undefined;
  private workerAvailable = false;
  private queued = false;
  private playing = true;
  private displayedVoice:
    { pitch: number; at: number; position: number } | undefined;
  private sentVoice: ShowEngine['voiceHistory'][number] | undefined;
  private sentNotes: readonly ShowNote[] | undefined;
  private commands: FxCommand[] = [];
  private ratio = 1;
  private workerLayout: RollLayout | undefined;
  private glowLayout: RollLayout['glow'];
  private glowRoot: HTMLElement | undefined;
  private glowContext: PaintContext | null = null;
  private fallbackCanvas: HTMLCanvasElement | undefined;
  private frame = 0;
  private readonly host: Window | typeof globalThis;
  private lane = { left: 0, top: 0, width: 0, height: 0 };
  private page = { left: 0, top: 0 };
  private laneAt = -Infinity;
  private traces = new Map<string, Trace[]>();
  private sparkles: Moment[] = [];
  private glints: Moment[] = [];
  private stars: Moment[] = [];
  private waves: Moment[] = [];
  private passes: Moment[] = [];
  private bursts: Moment[] = [];
  private level = '';
  private unsubscribe: () => void;
  private contourTextures = new Map<ShowNote, Map<number, ContourTexture>>();
  private contourView: RollView | undefined;
  private contourSize = '';

  constructor(
    private canvas: PaintCanvas,
    private engine: RollEngine,
    private frameElement: HTMLElement | undefined,
    private view: { current: RollView | undefined },
    private glowCanvas?: PaintCanvas,
    createWorker?: () => Worker,
  ) {
    this.host = frameElement?.ownerDocument.defaultView ?? globalThis;
    this.context = null;
    if (
      createWorker &&
      frameElement &&
      canvas instanceof HTMLCanvasElement &&
      typeof Worker !== 'undefined' &&
      canvas.transferControlToOffscreen
    ) {
      try {
        const worker = createWorker();
        this.worker = worker;
        worker.onmessage = ({ data }) => {
          if (this.worker !== worker) return;
          if (data.type === 'failed') {
            this.restoreCanvas();
            return;
          }
          this.workerAvailable = true;
          this.engine.voicePoint = data.voicePoint;
          if (
            data.type === 'frame' &&
            !this.glowRoot?.hasAttribute('data-show-roll-glow')
          )
            this.glowRoot?.setAttribute('data-show-roll-glow', '');
          if (this.queued) {
            this.queued = false;
            this.draw(performance.now());
          }
        };
        worker.onerror = () => {
          if (this.worker === worker) this.restoreCanvas();
        };
        const offscreen = canvas.transferControlToOffscreen();
        this.glowRoot = frameElement.matches('.ad-melody-roll')
          ? frameElement
          : (frameElement.querySelector<HTMLElement>('.ad-melody-roll') ??
            undefined);
        const glow = document.createElement('canvas');
        glow.className = 'showRollGlow';
        glow.setAttribute('aria-hidden', 'true');
        this.glowRoot?.append(glow);
        this.glowCanvas = glow;
        const glowOffscreen = glow.transferControlToOffscreen();
        worker.postMessage(
          { type: 'init', canvas: offscreen, glow: glowOffscreen },
          [offscreen, glowOffscreen],
        );
      } catch {
        this.restoreCanvas();
      }
    }
    if (!this.worker) {
      this.context = this.canvas.getContext('2d');
      this.glowContext = this.glowCanvas?.getContext('2d') ?? null;
    }
    this.lightContext = this.light.getContext('2d');
    this.bloomContext = this.bloom.getContext('2d');
    this.unsubscribe = engine.onCommand((command) => {
      if (!this.playing) return;
      if (this.worker) this.commands.push(command);
      else this.onCommand(command);
    });
  }

  private restoreCanvas(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.workerAvailable = false;
    this.glowRoot?.removeAttribute('data-show-roll-glow');
    if (this.glowCanvas instanceof HTMLCanvasElement) this.glowCanvas.remove();
    this.glowCanvas = undefined;
    if (this.canvas instanceof HTMLCanvasElement) {
      const replacement = document.createElement('canvas');
      replacement.className = this.canvas.className;
      replacement.setAttribute('aria-hidden', 'true');
      replacement.style.cssText = this.canvas.style.cssText;
      this.canvas.after(replacement);
      this.canvas.style.display = 'none';
      this.canvas = replacement;
      this.fallbackCanvas = replacement;
      this.context = replacement.getContext('2d');
      this.laneAt = -Infinity;
    }
    for (const command of this.commands) this.onCommand(command);
    this.commands = [];
  }

  start(): void {
    this.host.cancelAnimationFrame(this.frame);
    // The next frame is booked first, so one failed frame can never stop the show.
    const tick = () => {
      this.frame = this.host.requestAnimationFrame(tick);
      this.draw(performance.now());
    };
    this.frame = this.host.requestAnimationFrame(tick);
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (playing) this.start();
    else {
      this.commands = [];
      this.host.cancelAnimationFrame(this.frame);
      this.draw(performance.now());
    }
  }

  stop(): void {
    this.host.cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.engine.voicePoint = undefined;
    this.contourTextures.clear();
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
    this.fallbackCanvas?.remove();
    this.glowRoot?.removeAttribute('data-show-roll-glow');
    if (
      typeof HTMLCanvasElement !== 'undefined' &&
      this.glowCanvas instanceof HTMLCanvasElement
    )
      this.glowCanvas.remove();
  }

  private onCommand(command: FxCommand): void {
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

  private measureLane(now: number): void {
    if (
      !this.frameElement ||
      !(this.canvas instanceof HTMLCanvasElement) ||
      now - this.laneAt < 250
    )
      return;
    this.laneAt = now;
    const lane = this.frameElement
      .querySelector('.ad-melody-roll-lane')
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
    style.clipPath = `inset(${margin}px)`;
    if (this.glowRoot && this.glowCanvas instanceof HTMLCanvasElement) {
      const style = getComputedStyle(this.glowRoot);
      const blur =
        parseFloat(
          getComputedStyle(this.frameElement.ownerDocument.documentElement)
            .fontSize,
        ) * 2.6;
      const width = parseFloat(style.width),
        height = parseFloat(style.height);
      this.glowLayout = {
        width,
        height,
        blur,
        radius: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomRightRadius,
          style.borderBottomLeftRadius,
        ].map(parseFloat),
      };
      const pad = Math.ceil(blur * 2);
      Object.assign(this.glowCanvas.style, {
        position: 'absolute',
        pointerEvents: 'none',
        zIndex: '-1',
        left: `${-pad}px`,
        top: `${-pad}px`,
        width: `${width + pad * 2}px`,
        height: `${height + pad * 2}px`,
      });
    }
    this.resize({
      lane: this.lane,
      page: this.page,
      glow: this.glowLayout,
      ratio: Math.min(2, this.host.devicePixelRatio || 1),
    });
  }

  resize({ lane, page, ratio, glow }: RollLayout): void {
    this.glowLayout = glow;
    this.lane = lane;
    this.page = page;
    this.ratio = ratio;
    if (this.worker) {
      this.workerLayout = { lane, page, ratio, glow };
      return;
    }
    if (glow && this.glowCanvas) {
      const pad = Math.ceil(glow.blur * 2);
      const width = Math.round((glow.width + pad * 2) * ratio),
        height = Math.round((glow.height + pad * 2) * ratio);
      if (this.glowCanvas.width !== width) this.glowCanvas.width = width;
      if (this.glowCanvas.height !== height) this.glowCanvas.height = height;
    }
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

  draw(now: number): void {
    this.measureLane(now);
    if (this.worker) {
      if (this.workerAvailable) {
        this.workerAvailable = false;
        const view = this.view.current;
        const history = this.engine.voiceHistory;
        const last = this.sentVoice ? history.indexOf(this.sentVoice) : -1;
        const message: RollFrame = {
          type: 'frame',
          now: performance.timeOrigin + now,
          layout: this.workerLayout,
          state: this.engine.state,
          history: history.slice(last + 1),
          resetHistory: last < 0,
          historyFrom: history[0]?.position ?? Infinity,
          view: view
            ? {
                ...view,
                notes: view.notes === this.sentNotes ? undefined : view.notes,
              }
            : undefined,
          commands: this.commands,
        };
        this.commands = [];
        this.workerLayout = undefined;
        this.sentNotes = view?.notes;
        this.sentVoice = history.at(-1);
        this.worker.postMessage(message);
      } else this.queued = true;
      return;
    }
    this.drawGlow();
    const context = this.context;
    const small = this.lightContext;
    const blurred = this.bloomContext;
    const view = this.view.current;
    if (!context || !small || !blurred) return;
    const fullWidth = this.lane.width + margin * 2;
    const ratio = this.canvas.width / Math.max(1, fullWidth);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
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
      target.globalCompositeOperation = 'lighter';
      this.paint(target, view, geometry, now);
    }
    blurred.setTransform(1, 0, 0, 1, 0, 0);
    blurred.clearRect(0, 0, this.bloom.width, this.bloom.height);
    blurred.filter = 'blur(3px)';
    blurred.drawImage(this.light, 0, 0);
    blurred.filter = 'none';
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(this.bloom, 0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(this.bloom, 0, 0, this.canvas.width, this.canvas.height);
    context.globalCompositeOperation = 'source-over';
  }

  private drawGlow(): void {
    const context = this.glowContext,
      layout = this.glowLayout;
    if (!context || !layout) return;
    const { width, height, radius, blur } = layout;
    const pad = Math.ceil(blur * 2),
      ratio = this.ratio;
    const amount = Number(this.engine.state.ambient.rollGlow.toFixed(3));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width + pad * 2, height + pad * 2);
    if (amount <= 0) return;
    context.save();
    context.beginPath();
    context.rect(0, 0, width + pad * 2, height + pad * 2);
    context.roundRect(pad, pad, width, height, radius);
    context.clip('evenodd');
    const offset = width + pad * 4;
    context.shadowOffsetX = offset * ratio;
    context.shadowBlur = blur * amount * ratio;
    context.shadowColor = `rgb(255 46 138 / ${amount * 0.28})`;
    context.fillStyle = '#000';
    context.beginPath();
    context.roundRect(pad - offset, pad, width, height, radius);
    context.fill();
    context.restore();
  }

  private paint(
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
    this.drawVoiceTrail(context, view, geometry);
    this.drawVoice(context, view, geometry, now);
  }

  /** The fine reference contour is visible over the held-note capsules used for phrasing. */
  private drawTarget(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
  ): void {
    const size = `${this.lane.width}:${this.lane.height}:${view.span}:${view.low}:${view.high}`;
    if (this.contourView?.notes !== view.notes || this.contourSize !== size) {
      this.contourTextures.clear();
      this.contourView = view;
      this.contourSize = size;
    }
    const scale = context.getTransform().a;
    context.strokeStyle = rgba('white', 0.75);
    context.lineWidth = 1.5;
    for (const note of view.notes) {
      if (!note.contour?.length) continue;
      const left = geometry.x(note.start) - 2;
      const width = ((note.end - note.start) * this.lane.width) / view.span + 4;
      if (left > this.lane.width + margin || left + width < margin) continue;
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
        const brush = canvas.getContext('2d');
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
    if ((trace.at(-1)?.t ?? -Infinity) < live.position)
      trace.push({ t: live.position, q: live.accuracy });
    this.traces.set(live.note.id, trace);
  }

  private drawHalo(context: PaintContext, view: RollView): void {
    const glow = this.engine.state.ambient.rollGlow;
    const strength = glow * 0.22;
    if (strength < 0.01) return;
    const x = margin + this.lane.width * view.lead;
    const gradient = context.createLinearGradient(x - 22, 0, x + 22, 0);
    gradient.addColorStop(0, rgba('pink', 0));
    gradient.addColorStop(0.5, rgba('pink', strength));
    gradient.addColorStop(1, rgba('pink', 0));
    context.fillStyle = gradient;
    context.fillRect(x - 22, margin, 44, this.lane.height);
  }

  /** A note about to reach the playhead is outlined softly, to help the singer prepare to enter it. */
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

  /** The voice's light on the notes: thick and white-hot where it was true, thin and pink where it drifted. */
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
    const centerY = margin + this.lane.height / 2;
    const voiceX = margin + this.lane.width * view.lead;
    context.lineWidth = 1.5;
    for (const wave of this.waves) {
      const p = phase(now, wave.start, waveMs);
      const radius = 10 + this.lane.width * 0.6 * easeOutCubic(p);
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
      const x = margin - 100 + (this.lane.width + 200) * easeOutCubic(p);
      const gradient = context.createLinearGradient(x - 70, 0, x + 70, 0);
      const alpha = Math.min(1, pass.strength) * Math.sin(Math.PI * p) * 0.28;
      gradient.addColorStop(0, rgba('pink', 0));
      gradient.addColorStop(0.5, rgba('white', alpha));
      gradient.addColorStop(1, rgba('pink', 0));
      context.fillStyle = gradient;
      context.fillRect(x - 70, margin, 140, this.lane.height);
    }
  }

  /** A four-point star: hot core, soft glow and the two glare streaks of a bright light. */
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

  /**
   * The voice itself: a white-hot point where it is true, and around it a thin ring that fills towards the next
   * level of the show — visible progress makes the next reward feel within reach.
   */
  private drawVoice(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
    now: number,
  ): void {
    const state = this.engine.state;
    const observation = this.engine.voiceHistory.at(-1);
    const x = geometry.x(observation?.position ?? view.position);
    const live = state.live;
    const measured =
      observation?.audioActive &&
      state.playing &&
      Math.abs(view.position - observation.position) <= 0.5
        ? pitchHzToMidi(
            reliablePitchHz(observation.pitchHz, observation.confidence),
          )
        : undefined;
    const previous = this.displayedVoice;
    const midi =
      measured !== undefined &&
      previous &&
      observation &&
      observation.position >= previous.position &&
      observation.position - previous.position < 0.2
        ? approach(
            previous.pitch,
            measured,
            Math.max(0, now - previous.at) / 1000,
            0.035,
          )
        : measured;
    this.displayedVoice =
      midi !== undefined && observation
        ? { pitch: midi, at: now, position: observation.position }
        : undefined;
    const boundedMidi = Math.max(
      view.low,
      Math.min(view.high, midi ?? (view.low + view.high) / 2),
    );
    const y = geometry.y(boundedMidi);
    const visible = midi !== undefined && midi === boundedMidi;
    this.engine.voicePoint = visible
      ? { x: this.page.left + x, y: this.page.top + y }
      : undefined;
    if (state.level !== this.level) {
      if (this.level !== '' && state.energy > 1)
        this.bursts.push({ start: now, strength: 1 });
      this.level = state.level;
    }
    if (midi === undefined) return;
    const markerY = Math.max(
      margin + 10,
      Math.min(margin + this.lane.height - 10, y),
    );
    context.strokeStyle = rgba('white', 0.95);
    context.fillStyle = context.strokeStyle;
    context.lineWidth = 2;
    context.setLineDash([]);
    context.beginPath();
    if (!visible) {
      const direction = Math.sign(boundedMidi - midi);
      context.moveTo(x - 6, markerY - direction * 4);
      context.lineTo(x, markerY + direction * 4);
      context.lineTo(x + 6, markerY - direction * 4);
    } else {
      context.arc(x, markerY, 6, 0, Math.PI * 2);
      context.fill();
    }
    context.stroke();
    if (!visible) return;
    const radius = Math.max(15, geometry.row * 1.25);
    const accuracy = live?.deviation === undefined ? 0 : live.accuracy;
    if (accuracy > 0.2) {
      const core = context.createRadialGradient(x, y, 0, x, y, radius * 1.4);
      core.addColorStop(0, rgba('white', accuracy));
      core.addColorStop(0.18, rgba('pink', accuracy * 0.7));
      core.addColorStop(1, rgba('magenta', 0));
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
    context.strokeStyle = rgba('white', 0.12 * ringAlpha);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = rgba('pink', 0.85 * ringAlpha);
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
      context.strokeStyle = rgba('white', (1 - p) ** 1.5);
      context.lineWidth = 2.5 * (1 - p) + 0.5;
      context.beginPath();
      context.arc(x, y, radius * (1 + 1.8 * easeOutCubic(p)), 0, Math.PI * 2);
      context.stroke();
    }
  }

  private drawVoiceTrail(
    context: PaintContext,
    view: RollView,
    geometry: Geometry,
  ): void {
    context.lineWidth = Math.max(1.5, geometry.row * 0.1);
    context.strokeStyle = rgba('white', 0.85);
    context.beginPath();
    let previous: number | undefined;
    for (const observation of this.engine.voiceHistory) {
      const midi = pitchHzToMidi(
        reliablePitchHz(observation.pitchHz, observation.confidence),
      );
      if (midi === undefined || midi < view.low || midi > view.high) {
        previous = undefined;
        continue;
      }
      const x = geometry.x(observation.position),
        y = geometry.y(midi);
      if (previous === undefined || observation.position - previous > 0.1)
        context.moveTo(x, y);
      else context.lineTo(x, y);
      previous = observation.position;
    }
    context.stroke();
  }
}
