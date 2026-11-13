import { afterEach, expect, it, vi } from 'vitest';
import { RollFxRenderer } from './rollFxRenderer';
import { ShowEngine } from './showEngine';

const context = () =>
  new Proxy(
    {
      arc: vi.fn(),
      getTransform: () => ({ a: 1 }),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    },
    { get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
  );

const setup = () => {
  const paints: ReturnType<typeof context>[] = [];
  vi.stubGlobal('document', undefined);
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      width = 848;
      height = 288;
      paint = context();
      constructor() {
        paints.push(this.paint);
      }
      getContext() {
        return this.paint;
      }
    },
  );
  const engine = new ShowEngine();
  const view = {
    current: { notes: [], position: 1, span: 8, lead: 0.25, low: 48, high: 84 },
  };
  const renderer = new RollFxRenderer(
    new OffscreenCanvas(848, 288),
    engine,
    undefined,
    view,
  );
  renderer.resize({
    lane: { left: 0, top: 0, width: 800, height: 240 },
    page: { left: 0, top: 0 },
    ratio: 1,
  });
  const markerY = () =>
    paints[0]!.arc.mock.calls.find((call) => call[2] === 6)?.[1];
  const draw = (now: number) => {
    paints[0]!.arc.mockClear();
    renderer.draw(now);
    return markerY();
  };
  const observe = (position: number, pitchHz: number, confidence = 0.95) => {
    view.current.position = position;
    engine.advance(
      position * 1000,
      position,
      pitchHz,
      true,
      0.02,
      true,
      true,
      confidence,
    );
  };
  return { engine, renderer, view, draw, observe };
};

afterEach(() => vi.unstubAllGlobals());

it('draws captured pitch changes continuously while retaining the original observations', () => {
  const { engine, renderer, draw, observe } = setup();
  observe(1, 440);
  const first = draw(0);
  observe(1.02, 880);
  const next = draw(16);
  const settled = draw(180);
  expect(first).toBeDefined();
  expect(next).toBeGreaterThan(settled!);
  expect(next).toBeLessThan(first!);
  expect(engine.voiceHistory.at(-1)?.pitchHz).toBe(880);
  renderer.stop();
});

it('does not publish a live voice point for an uncertain or stale capture frame', () => {
  const { engine, renderer, view, draw, observe } = setup();
  observe(1, 440, 0.2);
  draw(0);
  expect(engine.voicePoint).toBeUndefined();
  observe(1.02, 440);
  draw(16);
  expect(engine.voicePoint).toBeDefined();
  view.current.position = 2;
  draw(1000);
  expect(engine.voicePoint).toBeUndefined();
  renderer.stop();
});
