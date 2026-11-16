import { LightBatch, spriteFloats } from './gl/lightBatch';
import { CanvasLightRenderer, type Rect } from './gl/canvasLightRenderer';
import { StageScene, particleBudgets, type StageLayout } from './stageScene';
import type { ShowEngine } from './showEngine';

const qualityRatios = [0.5, 0.65, 0.8, 1] as const;
const rectOf = (rect: DOMRect | undefined): Rect | undefined =>
  rect
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : undefined;

/**
 * Performance rewards share one canvas. The lyrics react to music through CSS variables;
 * the stage draws particles, rings and brief highlights without spotlights over the clip.
 */
export class StageFxRenderer {
  private light: CanvasLightRenderer | undefined;
  private worker: Worker | undefined;
  private workerReady = false;
  private workerBuffer: Float32Array | undefined;
  private fallbackCanvas: HTMLCanvasElement | undefined;
  private pixelWidth = 1;
  private pixelHeight = 1;
  private batch = new LightBatch(1400);
  private quality = 2;
  private frameTimes: number[] = [];
  private smoothWindows = 0;
  private frame = 0;
  private last = 0;
  private lastLightAt = -Infinity;
  private layout: StageLayout = {
    width: 0,
    height: 0,
    anchors: { consoleVisible: true },
  };
  private scene: StageScene;
  private anchorsAt = 0;
  private sizeAt = -Infinity;
  private sizedQuality = -1;
  private styles = new Map<string, { element: HTMLElement; value: string }>();
  private sweepToggle = false;
  private unsubscribe: () => void;
  private readonly view: Window;

  private events = new AbortController();

  constructor(
    private canvas: HTMLCanvasElement,
    private engine: ShowEngine,
    private host: HTMLElement,
  ) {
    this.view = host.ownerDocument.defaultView ?? window;
    this.scene = new StageScene(engine, this.layout, () => this.sweepConsole());
    if (typeof Worker !== 'undefined' && canvas.transferControlToOffscreen) {
      try {
        const worker = new Worker(
          new URL('./gl/lightWorker.ts', import.meta.url),
          { type: 'module' },
        );
        this.worker = worker;
        worker.onmessage = (event: MessageEvent) => {
          if (this.worker !== worker) return;
          const { type } = event.data;
          if (type === 'failed') this.restoreCanvas();
          else if (type === 'ready') {
            this.workerReady = true;
            this.workerBuffer = new Float32Array(this.batch.sprites.length);
          } else if (type === 'frame') {
            this.workerBuffer = new Float32Array(event.data.sprites);
          }
        };
        const recover = () => {
          if (this.worker === worker) this.restoreCanvas();
        };
        worker.onerror = recover;
        worker.onmessageerror = recover;
        const offscreen = canvas.transferControlToOffscreen();
        worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
      } catch {
        this.restoreCanvas();
      }
    } else {
      this.light = CanvasLightRenderer.create(canvas);
    }
    this.unsubscribe = engine.onCommand((command) =>
      this.scene.onCommand(command),
    );
    const { signal } = this.events;
    this.view.addEventListener(
      'resize',
      () => {
        this.sizeAt = -Infinity;
      },
      { signal },
    );
  }

  private restoreCanvas(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.workerReady = false;
    this.workerBuffer = undefined;
    const replacement = this.canvas.ownerDocument.createElement('canvas');
    replacement.className = this.canvas.className;
    replacement.style.cssText = this.canvas.style.cssText;
    replacement.setAttribute('aria-hidden', 'true');
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    this.fallbackCanvas = replacement;
    this.light = CanvasLightRenderer.create(replacement);
    this.sizeAt = -Infinity;
  }

  start(): void {
    this.view.cancelAnimationFrame(this.frame);
    this.last = 0;
    // The next frame is booked first, so one failed frame can never stop the show.
    const tick = () => {
      this.frame = this.view.requestAnimationFrame(tick);
      this.draw(performance.now());
    };
    this.frame = this.view.requestAnimationFrame(tick);
  }

  setPlaying(playing: boolean): void {
    if (playing) this.start();
    else this.view.cancelAnimationFrame(this.frame);
  }

  stop(): void {
    this.view.cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.events.abort();
    this.light?.dispose();
    this.worker?.terminate();
    this.worker = undefined;
    this.fallbackCanvas?.remove();
    for (const [name, { element }] of this.styles)
      element.style.removeProperty(name);
    this.styles.clear();
    delete this.host.dataset.showSweep;
  }

  private sweepConsole(): void {
    this.sweepToggle = !this.sweepToggle;
    this.host.dataset.showSweep = this.sweepToggle ? 'a' : 'b';
  }

  private readAnchors(now: number): void {
    if (now - this.anchorsAt < 250) return;
    this.anchorsAt = now;
    const box = (selector: string) => {
      const rect = this.host.querySelector(selector)?.getBoundingClientRect();
      return rect && rect.width > 0 ? rect : undefined;
    };
    const consoleCard = box('.karaokeConsoleCard');
    this.layout.anchors = {
      lyrics: box('.ad-lyrics-current'),
      roll: box('.pianoRoll .ad-melody-roll-lane'),
      rollPanel: box(':scope > .pianoRoll'),
      consoleVisible: Boolean(
        consoleCard && consoleCard.top < this.layout.height - 4,
      ),
    };
  }

  private resize(now: number): void {
    if (now - this.sizeAt < 250 && this.sizedQuality === this.quality) return;
    this.sizeAt = now;
    this.sizedQuality = this.quality;
    const ratio =
      Math.min(1.5, this.view.devicePixelRatio || 1) *
      (qualityRatios[this.quality] ?? 0.65);
    this.layout.width = this.canvas.clientWidth;
    this.layout.height = this.canvas.clientHeight;
    const width = Math.max(1, Math.round(this.layout.width * ratio));
    const height = Math.max(1, Math.round(this.layout.height * ratio));
    this.pixelWidth = width;
    this.pixelHeight = height;
    if (
      !this.worker &&
      (this.canvas.width !== width || this.canvas.height !== height)
    ) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.scene.pool.limit(particleBudgets[this.quality] ?? particleBudgets[0]);
  }

  /** Lower the resolution when frames run long, raise it again after a calm stretch. */
  private measure(elapsedMs: number): void {
    if (elapsedMs > 250) {
      this.frameTimes = [];
      return;
    }
    this.frameTimes.push(elapsedMs);
    if (this.frameTimes.length < 90) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    this.frameTimes = [];
    if (
      (sorted[Math.floor(sorted.length * 0.9)] ?? 0) > 24 &&
      this.quality > 0
    ) {
      this.quality -= 1;
      this.smoothWindows = 0;
    } else if (
      (sorted[Math.floor(sorted.length * 0.9)] ?? Infinity) < 18 &&
      ++this.smoothWindows >= 8 &&
      this.quality < qualityRatios.length - 1
    ) {
      this.quality += 1;
      this.smoothWindows = 0;
    }
  }

  private draw(now: number): void {
    const elapsedMs = this.last === 0 ? 16 : now - this.last;
    this.last = now;
    const elapsed = Math.min(0.05, elapsedMs / 1000);
    this.measure(elapsedMs);
    this.resize(now);
    this.readAnchors(now);
    this.scene.advance(now, elapsed);
    this.applyStyles();
    if (!this.light && !(this.workerReady && this.workerBuffer)) return;
    if (now - this.lastLightAt < 1000 / 30) return;
    this.lastLightAt = now;

    const batch = this.batch;
    batch.clear();
    this.scene.paint(batch, now);
    const view = { width: this.layout.width, height: this.layout.height };
    const protect = {
      lyrics: rectOf(this.layout.anchors.lyrics),
      roll: rectOf(this.layout.anchors.rollPanel),
    };
    if (this.worker && this.workerBuffer) {
      const sprites = this.workerBuffer;
      sprites.set(batch.sprites.subarray(0, batch.spriteCount * spriteFloats));
      this.workerBuffer = undefined;
      try {
        this.worker.postMessage(
          {
            type: 'frame',
            sprites: sprites.buffer,
            spriteCount: batch.spriteCount,
            width: this.pixelWidth,
            height: this.pixelHeight,
            view,
            protect,
          },
          [sprites.buffer],
        );
        return;
      } catch {
        this.restoreCanvas();
      }
    }
    this.light?.render(batch, view, protect);
  }

  /** Backing-track motion belongs only to the painted lyrics. */
  private applyStyles(): void {
    const beat = this.engine.state.musicBeat ?? 0;
    this.setStyle(
      '--show-music-beat',
      (beat * 0.4).toFixed(5),
      '.ad-lyrics-current',
    );
    this.setStyle(
      '--show-console-glow',
      (this.engine.state.ambient.consoleGlow * 0.85).toFixed(3),
      '.karaokeConsoleCard',
    );
    if (!this.host.querySelector('.pianoRollLane[data-show-roll-glow]'))
      this.setStyle(
        '--show-roll-glow',
        this.engine.state.ambient.rollGlow.toFixed(3),
        '.pianoRollLane',
      );
  }

  private setStyle(name: string, value: string, selector: string): void {
    const element = this.host.querySelector<HTMLElement>(selector);
    const previous = this.styles.get(name);
    if (previous?.element === element && previous.value === value) return;
    if (previous && previous.element !== element)
      previous.element.style.removeProperty(name);
    if (!element) {
      this.styles.delete(name);
      return;
    }
    // Scope animated variables to their consumer instead of invalidating the entire scene.
    element.style.setProperty(name, value);
    this.styles.set(name, { element, value });
  }
}
