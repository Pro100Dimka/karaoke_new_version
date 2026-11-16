import { RollNotePainter } from './rollFxNotes';
import {
  paintCanvas,
  paintContext,
  margin,
  type PaintCanvas,
  type PaintContext,
  type Geometry,
  type RollView,
  type RollEngine,
  type RollLayout,
  type RollFrame,
} from './rollFxPaint';
export type { RollView, RollEngine, RollFrame } from './rollFxPaint';
import type { ShowNote } from './performanceScoring';
import type { ShowEngine } from './showEngine';
import type { FxCommand } from './visualDirector';

const bloomScale = 0.33;

/**
 * Light inside the melody roll, where the singer is looking. The voice paints the notes it sings with light (hot
 * white where it is true, thinner and pink where it drifts), so every reward is visibly the singer's own; a ring
 * around the voice fills towards the next level of the show; perfect notes catch a glint and a small star. Drawn
 * twice per frame — blurred for bloom, then sharp — and never over the notes' own height, length or position.
 */
export class RollFxRenderer {
  private layout: RollLayout = {
    lane: { left: 0, top: 0, width: 0, height: 0 },
    page: { left: 0, top: 0 },
    ratio: 1,
  };
  private notes: RollNotePainter;
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
  private sentVoice: ShowEngine['voiceHistory'][number] | undefined;
  private sentNotes: readonly ShowNote[] | undefined;
  private commands: FxCommand[] = [];
  private workerLayout: RollLayout | undefined;
  private glowRoot: HTMLElement | undefined;
  private glowContext: PaintContext | null = null;
  private fallbackCanvas: HTMLCanvasElement | undefined;
  private frame = 0;
  private readonly host: Window | typeof globalThis;
  private laneAt = -Infinity;
  private unsubscribe: () => void;

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
    this.notes = new RollNotePainter(engine, this.layout);
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
      this.context = paintContext(this.canvas);
      this.glowContext = paintContext(this.glowCanvas);
    }
    this.lightContext = paintContext(this.light);
    this.bloomContext = paintContext(this.bloom);
    this.unsubscribe = engine.onCommand((command) => {
      if (!this.playing) return;
      if (this.worker) this.commands.push(command);
      else this.notes.onCommand(command);
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
    for (const command of this.commands) this.notes.onCommand(command);
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
    this.notes.dispose();
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
    this.layout.lane = {
      left: lane.left - frame.left,
      top: lane.top - frame.top,
      width: lane.width,
      height: lane.height,
    };
    this.layout.page = { left: lane.left - margin, top: lane.top - margin };
    const style = this.canvas.style;
    style.left = `${this.layout.lane.left - margin}px`;
    style.top = `${this.layout.lane.top - margin}px`;
    style.width = `${this.layout.lane.width + margin * 2}px`;
    style.height = `${this.layout.lane.height + margin * 2}px`;
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
      this.layout.glow = {
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
      lane: this.layout.lane,
      page: this.layout.page,
      glow: this.layout.glow,
      ratio: Math.min(2, this.host.devicePixelRatio || 1),
    });
  }

  resize({ lane, page, ratio, glow }: RollLayout): void {
    this.layout.glow = glow;
    this.layout.lane = lane;
    this.layout.page = page;
    this.layout.ratio = ratio;
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
    const width = Math.round((this.layout.lane.width + margin * 2) * ratio);
    const height = Math.round((this.layout.lane.height + margin * 2) * ratio);
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
    const { width, height } = this.layout.lane;
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
    const fullWidth = this.layout.lane.width + margin * 2;
    const ratio = this.canvas.width / Math.max(1, fullWidth);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.notes.expire(now);
    if (!view || this.layout.lane.width === 0) return;
    const geometry = this.geometry(view);
    this.notes.record(view);

    // The light once sharp on the overlay, once small for the bloom.
    small.setTransform(1, 0, 0, 1, 0, 0);
    small.clearRect(0, 0, this.light.width, this.light.height);
    for (const [target, scale] of [
      [context, ratio],
      [small, ratio * bloomScale],
    ] as const) {
      target.setTransform(scale, 0, 0, scale, 0, 0);
      target.globalCompositeOperation = 'lighter';
      this.notes.paint(target, view, geometry, now);
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
      layout = this.layout.glow;
    if (!context || !layout) return;
    const { width, height, radius, blur } = layout;
    const pad = Math.ceil(blur * 2),
      ratio = this.layout.ratio;
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
}
