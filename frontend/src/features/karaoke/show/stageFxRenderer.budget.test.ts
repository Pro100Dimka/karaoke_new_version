import { afterEach, expect, it, vi } from "vitest";
import { StageFxRenderer } from "./stageFxRenderer";
import { ShowEngine } from "./showEngine";
import { LightRenderer } from "./gl/lightRenderer";
import { CanvasLightRenderer } from "./gl/canvasLightRenderer";
import type { FxCommand } from "./visualDirector";

vi.mock("./gl/lightRenderer", () => ({ LightRenderer: { create: vi.fn(() => undefined) } }));
vi.mock("./gl/canvasLightRenderer", () => ({ CanvasLightRenderer: { create: vi.fn(() => undefined) } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(LightRenderer.create).mockClear();
  vi.mocked(CanvasLightRenderer.create).mockClear();
});

it("limits lyric enlargement to less than one percent even on the strongest beat", () => {
  const host = document.createElement("main");
  const engine = {
    onCommand: () => () => {},
    state: {
      musicBeat: 1,
      settings: { reducedMotion: false },
      ambient: { rollGlow: 0, consoleGlow: 0 },
    },
  } as unknown as ShowEngine;
  const renderer = new StageFxRenderer(
    document.createElement("canvas"),
    engine,
    host,
  );
  (renderer as unknown as { applyStyles(): void }).applyStyles();
  const pulse = Number(host.style.getPropertyValue("--show-music-beat"));
  expect(pulse).toBeGreaterThan(0.3);
  expect(1 + pulse * 0.022).toBeLessThan(1.01);
  renderer.stop();
});

it("reacts to isolated rhythm with zero performance energy and no microphone pitch", () => {
  const engine = new ShowEngine();
  engine.load([], [], new Map(), true, undefined, [[0.032, 1]]);
  engine.advance(0, 0, undefined, true);
  engine.hear(Array(18).fill(0), 0);
  engine.hear([0.8, 0.8, 0.8, 0.8, 0.8, ...Array(13).fill(0)], 16);
  engine.advance(32, 0.032, undefined, true);
  expect(engine.state.energy).toBe(0);
  expect(engine.state.musicBeat).toBeGreaterThan(0.8);
});

it("never draws spotlights even at maximum energy and during large rewards", () => {
  const beams: number[] = [];
  vi.mocked(CanvasLightRenderer.create).mockReturnValueOnce({
    render: (batch: { beamCount: number }) => beams.push(batch.beamCount), dispose: vi.fn(),
  } as unknown as CanvasLightRenderer);
  let command: (value: FxCommand) => void = () => {};
  const engine = {
    onCommand: (listener: typeof command) => { command = listener; return () => {}; },
    state: { musicBeat: 0, settings: { reducedMotion: false },
      ambient: { grade: 1, beams: 6, particles: 0, consoleGlow: 1, rollGlow: 1 } },
  } as unknown as ShowEngine;
  const canvas = document.createElement("canvas");
  Object.defineProperties(canvas, { clientWidth: { value: 1024 }, clientHeight: { value: 768 } });
  const renderer = new StageFxRenderer(canvas, engine, document.body);
  const stage = renderer as unknown as { draw(now: number): void };
  command({ kind: "stageExpansion", at: 0, strength: 1 });
  command({ kind: "crossLight", at: 0, strength: 1 });
  for (let now = 1000; now < 7000; now += 50) stage.draw(now);
  expect(beams.length).toBeGreaterThan(0);
  expect(beams.every((count) => count === 0)).toBe(true);
  renderer.stop();
});

it("publishes the musical pulse for lyrics without moving the video", () => {
  let command: (value: FxCommand) => void = () => {};
  const host = document.createElement("main");
  const engine = {
    onCommand: (listener: typeof command) => { command = listener; return () => {}; },
    state: { musicBeat: 0.8, settings: { reducedMotion: false }, ambient: { consoleGlow: 0, rollGlow: 0 } },
  } as unknown as ShowEngine;
  const renderer = new StageFxRenderer(document.createElement("canvas"), engine, host);
  command({ kind: "beatPulse", at: 0, strength: 1 });
  const stage = renderer as unknown as { applyStyles(): void };
  stage.applyStyles();
  expect(Number(host.style.getPropertyValue("--show-music-beat"))).toBe(0.32);
  expect(host.style.getPropertyValue("--show-video-scale")).toBe("");
  command({ kind: "noteGlow", at: 0, strength: 1 });
  command({ kind: "phraseSweep", at: 0, strength: 1 });
  stage.applyStyles();
  expect(host.style.getPropertyValue("--show-lyric-glow")).toBe("");
  expect(Number(host.style.getPropertyValue("--show-music-beat"))).toBe(0.32);
  renderer.stop();
});

it("initializes stage light away from the main thread when OffscreenCanvas is available", () => {
  const canvas = document.createElement("canvas");
  const offscreen = { width: 0, height: 0 } as OffscreenCanvas;
  const postMessage = vi.fn();
  const terminate = vi.fn();
  class WorkerMock {
    postMessage = postMessage;
    terminate = terminate;
    onmessage = null;
  }
  Object.defineProperty(canvas, "transferControlToOffscreen", { value: () => offscreen });
  vi.stubGlobal("Worker", WorkerMock);
  const engine = { onCommand: () => () => undefined } as unknown as ShowEngine;

  const renderer = new StageFxRenderer(canvas, engine, document.body);

  expect(LightRenderer.create).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({ type: "init", canvas: offscreen }, [offscreen]);
  renderer.stop();
  expect(terminate).toHaveBeenCalledOnce();
});

it("does not require WebGL for the stage when workers are unavailable", () => {
  const engine = { onCommand: () => () => undefined } as unknown as ShowEngine;
  const renderer = new StageFxRenderer(document.createElement("canvas"), engine, document.body);
  expect(LightRenderer.create).not.toHaveBeenCalled();
  renderer.stop();
});

it("draws the light layer at most once per 30 Hz interval", () => {
  const render = vi.fn();
  vi.mocked(CanvasLightRenderer.create).mockReturnValueOnce({ render, dispose: vi.fn() } as unknown as CanvasLightRenderer);
  const engine = {
    onCommand: () => () => undefined,
    state: { settings: { reducedMotion: false }, ambient: { grade: 0, beams: 0, consoleGlow: 0, rollGlow: 0 } },
  } as unknown as ShowEngine;
  const renderer = new StageFxRenderer(document.createElement("canvas"), engine, document.body);
  const stage = renderer as unknown as { draw(now: number): void };
  stage.draw(1000);
  stage.draw(1016);
  stage.draw(1034);
  expect(render).toHaveBeenCalledTimes(2);
  renderer.stop();
});

it("does not force a canvas layout measurement on every animation frame", () => {
  const canvas = document.createElement("canvas");
  let reads = 0;
  Object.defineProperties(canvas, {
    clientWidth: { get: () => { reads++; return 800; } },
    clientHeight: { get: () => 600 },
  });
  const engine = { onCommand: () => () => undefined } as unknown as ShowEngine;
  const renderer = new StageFxRenderer(canvas, engine, document.body);
  const resize = renderer as unknown as { resize(now: number): void };
  resize.resize(1000);
  resize.resize(1016);
  expect(reads).toBe(1);
  window.dispatchEvent(new Event("resize"));
  resize.resize(1032);
  expect(reads).toBe(2);
  renderer.stop();
});

it("lowers light quality when recurring frame drops would be visible", () => {
  const engine = { onCommand: () => () => undefined } as unknown as ShowEngine;
  const renderer = new StageFxRenderer(document.createElement("canvas"), engine, document.body);
  const budget = renderer as unknown as { measure(ms: number): void; quality: number };
  for (let frame = 0; frame < 90; frame++) budget.measure(frame % 10 === 0 ? 33 : 16);
  expect(budget.quality).toBe(1);
  renderer.stop();
});

it("does not immediately restore expensive light quality after a brief calm passage", () => {
  const engine = { onCommand: () => () => undefined } as unknown as ShowEngine;
  const renderer = new StageFxRenderer(document.createElement("canvas"), engine, document.body);
  const budget = renderer as unknown as { measure(ms: number): void; quality: number };
  for (let frame = 0; frame < 90; frame++) budget.measure(frame % 10 === 0 ? 33 : 16);
  expect(budget.quality).toBe(1);
  for (let frame = 0; frame < 90 * 3; frame++) budget.measure(16);
  expect(budget.quality).toBe(1);
  renderer.stop();
});
