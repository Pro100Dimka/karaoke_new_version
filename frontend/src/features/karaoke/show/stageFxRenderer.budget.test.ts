import { afterEach, expect, it, vi } from "vitest";
import { StageFxRenderer } from "./stageFxRenderer";
import type { ShowEngine } from "./showEngine";
import { LightRenderer } from "./gl/lightRenderer";
import { CanvasLightRenderer } from "./gl/canvasLightRenderer";

vi.mock("./gl/lightRenderer", () => ({ LightRenderer: { create: vi.fn(() => undefined) } }));
vi.mock("./gl/canvasLightRenderer", () => ({ CanvasLightRenderer: { create: vi.fn(() => undefined) } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(LightRenderer.create).mockClear();
  vi.mocked(CanvasLightRenderer.create).mockClear();
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
