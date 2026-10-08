import { approach, light, type FxColor } from "./fxPalette";
import { LightBatch, beamVertexFloats, spriteFloats, spriteKind, type Rgb } from "./gl/lightBatch";
import { CanvasLightRenderer, type Rect } from "./gl/canvasLightRenderer";
import { ParticlePool } from "./particlePool";
import type { ShowEngine } from "./showEngine";
import { StageRig } from "./stageRig";
import type { FxCommand } from "./visualDirector";

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
/** The singer's light travelling from the voice up to the fixture it is about to switch on. */
interface Orb extends Timed {
  from: { x: number; y: number };
  fixture: number;
}

/** Where the readable parts of the screen are, refreshed a few times a second. */
interface Anchors {
  lyrics?: DOMRect;
  roll?: DOMRect;
  rollPanel?: DOMRect;
  consoleVisible: boolean;
}

const qualityRatios = [0.5, 0.65, 0.8, 1] as const;
const particleBudgets = [220, 380, 560, 760] as const;
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
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const rectOf = (rect: DOMRect | undefined): Rect | undefined =>
  rect
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : undefined;

/**
 * The stage: a dark room whose lights the singer switches on. Each fixture powers on only when a light released
 * from the voice reaches it, so the cause is always visible; the rig moves in designed looks; big moments are rare,
 * prepared by a darkening and released on the beat. Light is drawn on a canvas and the clip,
 * lyrics and console react through CSS variables on the page.
 */
export class StageFxRenderer {
  private light: CanvasLightRenderer | undefined;
  private worker: Worker | undefined;
  private workerReady = false;
  private workerBuffers: { sprites: Float32Array; beams: Float32Array } | undefined;
  private pixelWidth = 1;
  private pixelHeight = 1;
  private batch = new LightBatch(1400, 16);
  private rig = new StageRig();
  private pool = new ParticlePool(particleBudgets[3]);
  private quality = 2;
  private frameTimes: number[] = [];
  private smoothWindows = 0;
  private frame = 0;
  private last = 0;
  private lastLightAt = -Infinity;
  private anchors: Anchors = { consoleVisible: true };
  private anchorsAt = 0;
  private width = 0;
  private height = 0;
  private sizeAt = -Infinity;
  private sizedQuality = -1;
  private grade = 0;
  private kick = 0;
  private flash = 0;
  private expansion = 0;
  private lyricGlow = 0;
  private depth = 0;
  private rings: Ring[] = [];
  private flares: Flare[] = [];
  private orbs: Orb[] = [];
  private rain: Timed | undefined;
  private rainDebt = 0;
  private requested = 0;
  private styles = new Map<string, string>();
  private sweepToggle = false;
  private unsubscribe: () => void;

  private events = new AbortController();

  constructor(
    private canvas: HTMLCanvasElement,
    private engine: ShowEngine,
    private host: HTMLElement,
  ) {
    if (typeof Worker !== "undefined" && canvas.transferControlToOffscreen) {
      const worker = new Worker(new URL("./gl/lightWorker.ts", import.meta.url), { type: "module" });
      const offscreen = canvas.transferControlToOffscreen();
      this.worker = worker;
      worker.onmessage = (event: MessageEvent) => {
        if (event.data.type === "ready") {
          this.workerReady = true;
          this.workerBuffers = {
            sprites: new Float32Array(this.batch.sprites.length),
            beams: new Float32Array(this.batch.beams.length),
          };
        } else if (event.data.type === "frame") {
          this.workerBuffers = {
            sprites: new Float32Array(event.data.sprites),
            beams: new Float32Array(event.data.beams),
          };
        }
      };
      worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
    } else {
      this.light = CanvasLightRenderer.create(canvas);
    }
    this.unsubscribe = engine.onCommand((command) => this.onCommand(command));
    const { signal } = this.events;
    window.addEventListener("resize", () => { this.sizeAt = -Infinity; }, { signal });
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
    this.events.abort();
    this.light?.dispose();
    this.worker?.terminate();
    for (const name of this.styles.keys()) this.host.style.removeProperty(name);
    delete this.host.dataset.showSweep;
  }

  private get motion(): boolean {
    return !this.engine.state.settings.reducedMotion;
  }

  /** The singer's voice on screen: the light rides from here. */
  private voice(): { x: number; y: number } {
    const point = this.engine.voicePoint;
    if (point) return point;
    const roll = this.anchors.roll;
    if (roll)
      return {
        x: roll.left + roll.width * 0.25,
        y: roll.top + roll.height / 2,
      };
    const lyrics = this.anchors.lyrics;
    return lyrics
      ? { x: lyrics.left + lyrics.width / 2, y: lyrics.top + lyrics.height / 2 }
      : { x: this.width / 2, y: this.height / 2 };
  }

  private onCommand(command: FxCommand): void {
    const now = performance.now();
    const s = command.strength;
    const voice = this.voice();
    const lyrics = this.anchors.lyrics;
    const reach =
      Math.hypot(this.width, this.height) *
      (this.anchors.consoleVisible ? 0.6 : 0.75);
    switch (command.kind) {
      case "beatPulse":
        this.kick = Math.max(this.kick, s);
        return;
      case "noteGlow":
        if (s >= 0.92 && command.noteId) this.glintWord(command.noteId);
        return;
      case "chargeRelease":
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
        this.burst(voice.x, voice.y, 16 * s, 140, ["pink", "white"]);
        return;
      case "phraseSweep":
        this.lyricGlow = Math.max(this.lyricGlow, 0.45 * s);
        return;
      case "phraseBloom":
        this.lyricGlow = 1;
        if (lyrics)
          this.rig.setCue("focus", now, 1800, {
            x: lyrics.left + lyrics.width / 2,
            y: lyrics.top + lyrics.height / 2,
          });
        this.sweepConsole();
        return;
      case "crossLight":
        this.rig.setCue("cross", now, 2800);
        return;
      case "lightWave":
        this.flash = Math.max(this.flash, 0.25 * s);
        return;
      case "stageExpansion":
        this.expansion = Math.max(this.expansion, s);
        this.flash = Math.max(this.flash, 0.5 * s);
        this.rig.setCue("fan", now, 2600);
        this.rig.ignite(0.8);
        this.rings.push({
          x: this.width / 2,
          y: this.height + 40,
          radius: reach * 1.2,
          color: violet,
          start: now,
          duration: 1600,
          strength: s * 0.8,
        });
        this.burst(
          this.width / 2,
          this.height,
          60 * s,
          420,
          ["pink", "white", "violet", "gold"],
          true,
        );
        this.depth = Math.max(this.depth, s);
        return;
      case "shockwave":
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
        this.flash = Math.max(this.flash, 0.4 * s);
        this.depth = Math.max(this.depth, 0.8 * s);
        return;
      case "laserSweep":
        this.rig.setCue(this.motion ? "sweep" : "focus", now, 2200, voice);
        this.flash = Math.max(this.flash, 0.2 * s);
        return;
      case "firework":
        this.starburst(s);
        return;
      case "starRain":
        this.rain = { start: now, duration: 3200, strength: s };
        return;
      case "noteSparks":
      case "noteRing":
        // Drawn on the note itself by the melody roll's own layer.
        return;
    }
  }

  /** The word the perfect note was sung on catches the light for a moment. */
  private glintWord(noteId: string): void {
    const word = this.engine.wordOf(noteId);
    const line = this.host.querySelector(".ad-lyrics-current");
    if (
      !word ||
      !line ||
      line.textContent?.replace(/\s+/g, "") !== word.line.replace(/\s+/g, "")
    )
      return;
    const element = line.querySelectorAll(".ad-lyric-word")[word.index];
    if (!(element instanceof HTMLElement)) return;
    element.classList.remove("showGlint");
    void element.offsetWidth;
    element.classList.add("showGlint");
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
        color: colors[i % colors.length] ?? "white",
        gravity: 60,
        drag: 0.3,
        twinkle: i % 3 === 0,
      });
    }
  }

  /** A distant starburst: a flare and slow glitter, high on the stage and never over the line being read. */
  private starburst(strength: number): void {
    const { x, y } = this.distantSpot();
    const now = performance.now();
    const palettes = [
      ["gold", "white"],
      ["pink", "white"],
      ["violet", "pink"],
      ["cyan", "white"],
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

  /** Above the melody roll when there is room, else beside it. */
  private distantSpot(): { x: number; y: number } {
    const { width: w, height: h } = this;
    const panel = this.anchors.rollPanel;
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

  private sweepConsole(): void {
    this.sweepToggle = !this.sweepToggle;
    this.host.dataset.showSweep = this.sweepToggle ? "a" : "b";
  }

  private readAnchors(now: number): void {
    if (now - this.anchorsAt < 250) return;
    this.anchorsAt = now;
    const box = (selector: string) => {
      const rect = this.host.querySelector(selector)?.getBoundingClientRect();
      return rect && rect.width > 0 ? rect : undefined;
    };
    const consoleCard = box(".karaokeConsoleCard");
    this.anchors = {
      lyrics: box(".ad-lyrics-current"),
      roll: box(".pianoRoll .ad-melody-roll-lane"),
      rollPanel: box(":scope > .pianoRoll"),
      consoleVisible: Boolean(consoleCard && consoleCard.top < this.height - 4),
    };
  }

  private resize(now: number): void {
    if (now - this.sizeAt < 250 && this.sizedQuality === this.quality) return;
    this.sizeAt = now;
    this.sizedQuality = this.quality;
    const ratio =
      Math.min(1.5, window.devicePixelRatio || 1) *
      (qualityRatios[this.quality] ?? 0.65);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    const width = Math.max(1, Math.round(this.width * ratio));
    const height = Math.max(1, Math.round(this.height * ratio));
    this.pixelWidth = width;
    this.pixelHeight = height;
    if (!this.worker && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.pool.limit(particleBudgets[this.quality] ?? particleBudgets[0]);
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
    const state = this.engine.state;
    const time = now / 1000;
    this.grade = approach(
      this.grade,
      state.ambient.grade,
      elapsed,
      state.ambient.grade > this.grade ? 1.6 : 3.5,
    );
    this.kick *= Math.exp(-elapsed / 0.2);
    this.flash *= Math.exp(-elapsed / 0.5);
    this.expansion *= Math.exp(-elapsed / 2.4);
    this.lyricGlow *= Math.exp(-elapsed / 1.1);
    this.depth *= Math.exp(-elapsed / 0.3);
    this.rings = alive(this.rings, now);
    this.flares = alive(this.flares, now);
    if (this.rain && progress(this.rain, now) >= 1) this.rain = undefined;
    this.unlockFixtures(now, state.ambient.beams);
    this.advanceOrbs(now);
    this.rig.update(elapsed, now, time, this.width, this.motion);
    this.spawnRain(elapsed);
    this.pool.step(elapsed);
    this.applyStyles();
    if (!this.light && !(this.workerReady && this.workerBuffers)) return;
    if (now - this.lastLightAt < 1000 / 30) return;
    this.lastLightAt = now;

    const batch = this.batch;
    batch.clear();
    this.drawBokeh(batch, time);
    this.rig.draw(batch, this.width, this.height, {
      kick: this.kick,
      flash: this.flash,
      expansion: this.expansion,
    });
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
    for (const orb of this.orbs) this.drawOrb(batch, orb, now);
    this.pool.emit(batch, time);
    const view = { width: this.width, height: this.height };
    const protect = { lyrics: rectOf(this.anchors.lyrics), roll: rectOf(this.anchors.rollPanel) };
    const bloom = 0.85 + this.flash * 0.6;
    if (this.worker && this.workerBuffers) {
      const { sprites, beams } = this.workerBuffers;
      sprites.set(batch.sprites.subarray(0, batch.spriteCount * spriteFloats));
      beams.set(batch.beams.subarray(0, batch.beamCount * 3 * beamVertexFloats));
      this.workerBuffers = undefined;
      this.worker.postMessage({
        type: "frame", sprites: sprites.buffer, beams: beams.buffer,
        spriteCount: batch.spriteCount, beamCount: batch.beamCount,
        width: this.pixelWidth, height: this.pixelHeight, time, view, protect, bloom,
      }, [sprites.buffer, beams.buffer]);
    } else {
      this.light?.render(batch, time, view, protect, bloom);
    }
  }

  /** As the energy earns another fixture, a light leaves the voice and travels up to switch it on. */
  private unlockFixtures(now: number, beams: number): void {
    const wanted = Math.min(this.rig.fixtures.length, Math.floor(beams + 0.35));
    if (wanted < this.requested) {
      this.rig.powerDown(wanted);
      this.requested = wanted;
      this.orbs = this.orbs.filter((orb) => orb.fixture < wanted);
    }
    while (this.requested < wanted) {
      const delay = this.orbs.length * 260;
      this.orbs.push({
        from: this.voice(),
        fixture: this.requested,
        start: now + delay,
        duration: this.motion ? 850 : 300,
        strength: 1,
      });
      this.requested += 1;
    }
  }

  private advanceOrbs(now: number): void {
    this.orbs = this.orbs.filter((orb) => {
      if (progress(orb, now) < 1) return true;
      this.rig.powerOn(orb.fixture);
      return false;
    });
  }

  private orbAt(orb: Orb, t: number): { x: number; y: number } {
    const to = this.rig.lamp(orb.fixture, this.width);
    const control = {
      x: orb.from.x + (to.x - orb.from.x) * 0.15,
      y: Math.min(orb.from.y, to.y) + (orb.from.y - to.y) * 0.15 - 60,
    };
    const u = 1 - t;
    return {
      x: u * u * orb.from.x + 2 * u * t * control.x + t * t * to.x,
      y: u * u * orb.from.y + 2 * u * t * control.y + t * t * to.y,
    };
  }

  private drawOrb(batch: LightBatch, orb: Orb, now: number): void {
    if (now < orb.start) return;
    const p = progress(orb, now);
    const t = easeInOut(Math.min(1, p));
    const head = this.orbAt(orb, t);
    // A comet: the hot head and a fading tail along the path it took.
    for (let k = 8; k >= 1; k--) {
      const back = this.orbAt(orb, Math.max(0, t - k * 0.025));
      batch.sprite(
        back.x,
        back.y,
        22 - k * 1.5,
        spriteKind.glow,
        pink,
        (1 - k / 9) * 0.9,
      );
    }
    batch.sprite(head.x, head.y, 34, spriteKind.glow, white, 2.4);
    batch.sprite(head.x, head.y, 90, spriteKind.flare, pink, 0.9, 0.6);
  }

  private spawnRain(elapsed: number): void {
    if (!this.rain) return;
    this.rainDebt += this.rain.strength * 34 * elapsed;
    while (this.rainDebt >= 1) {
      this.rainDebt -= 1;
      this.pool.spawn({
        x: random(0, this.width),
        y: random(-20, this.height * 0.08),
        vx: random(-6, 6),
        vy: random(30, 80) * (this.motion ? 1 : 0.4),
        life: random(3, 4.5),
        size: random(3, 6),
        color: Math.random() < 0.5 ? "white" : "gold",
        twinkle: true,
      });
    }
  }

  /** At high energy a few large out-of-focus lights drift in the depth of the stage. */
  private drawBokeh(batch: LightBatch, time: number): void {
    const amount = Math.max(0, (this.grade - 0.45) / 0.55);
    if (amount < 0.01) return;
    const colors: Rgb[] = [pink, violet, [0.3, 0.8, 1], gold, pink, violet];
    for (const [i, color] of colors.entries()) {
      const drift = this.motion ? time * (0.008 + i * 0.002) : 0;
      const x = ((i * 0.173 + drift + 0.05) % 1) * this.width;
      const y = this.height * (0.12 + ((i * 0.41) % 0.8));
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

  /** The clip keeps its cheap depth pulse; light and colour come from the stage canvas. */
  private applyStyles(): void {
    this.setStyle(
      "--show-video-scale",
      (1 + (this.motion ? this.depth * 0.006 : 0)).toFixed(4),
    );
    this.setStyle("--show-lyric-glow", this.lyricGlow.toFixed(3));
    this.setStyle(
      "--show-console-glow",
      (
        this.engine.state.ambient.consoleGlow *
        (0.85 + this.kick * 0.15)
      ).toFixed(3),
    );
    this.setStyle(
      "--show-roll-glow",
      this.engine.state.ambient.rollGlow.toFixed(3),
    );
  }

  private setStyle(name: string, value: string): void {
    if (this.styles.get(name) === value) return;
    this.styles.set(name, value);
    this.host.style.setProperty(name, value);
  }
}
