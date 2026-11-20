import { afterEach, expect, it, vi } from 'vitest';
import { RollNotePainter } from './rollFxNotes';
import type {
  Geometry,
  PaintContext,
  RollLayout,
  RollView,
} from './rollFxPaint';
import { ShowEngine } from './showEngine';

const brush = () =>
  new Proxy(
    {
      getTransform: vi.fn(() => ({ a: 2 })),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
    },
    { get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
  );

const setup = () => {
  const canvases: Texture[] = [];
  class Texture {
    paint = brush();
    constructor(
      public width: number,
      public height: number,
    ) {
      canvases.push(this);
    }
    getContext() {
      return this.paint;
    }
  }
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('OffscreenCanvas', Texture);
  const layout: RollLayout = {
    lane: { left: 0, top: 0, width: 800, height: 240 },
    page: { left: 0, top: 0 },
    ratio: 2,
  };
  const view: RollView = {
    notes: Array.from({ length: 300 }, (_, index) => ({
      id: `note-${index}`,
      start: index * 2,
      end: index * 2 + 1,
      pitch: 60,
      contour: [
        [0, 0],
        [0.5, 2],
        [1, 0],
      ],
    })),
    position: 0,
    span: 8,
    lead: 0.25,
    low: 48,
    high: 84,
  };
  const painter = new RollNotePainter(new ShowEngine(), layout);
  const context = brush();
  const paint = (position: number, scale = 2) => {
    view.position = position;
    context.getTransform.mockReturnValue({ a: scale });
    const x = (seconds: number) =>
      24 +
      ((seconds - position + view.span * view.lead) / view.span) *
        layout.lane.width;
    const y = (pitch: number) => 24 + (view.high - pitch) * 6;
    const geometry: Geometry = {
      row: 6,
      x,
      y,
      box: (note) => ({
        x: x(note.start),
        y: y(note.pitch),
        width: x(note.end) - x(note.start),
        height: 6,
      }),
    };
    painter.paint(
      context as unknown as PaintContext,
      view,
      geometry,
      position * 1000,
    );
  };
  return { painter, canvases, paint };
};
afterEach(() => vi.unstubAllGlobals());

it('bounds retained contour bitmap storage by the visible notes throughout a long song', () => {
  const { painter, canvases, paint } = setup();
  let peakPixels = 0;
  for (let position = 0; position < 600; position += 2) {
    paint(position);
    paint(position, 0.66);
    peakPixels = Math.max(
      peakPixels,
      canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
    );
  }
  expect(peakPixels).toBeLessThan(100_000);
  painter.dispose();
  expect(canvases.every((canvas) => canvas.width * canvas.height === 0)).toBe(
    true,
  );
});

it('reuses visible contours and redraws the same texture after seeking back to an evicted note', () => {
  const { painter, canvases, paint } = setup();
  paint(0);
  const original = canvases[0]!;
  const size = [original.width, original.height];
  const paths = {
    move: [...original.paint.moveTo.mock.calls],
    line: [...original.paint.lineTo.mock.calls],
  };
  const count = canvases.length;
  paint(0.1);
  expect(canvases).toHaveLength(count);
  paint(400);
  expect(original.width * original.height).toBe(0);
  const farCount = canvases.length;
  paint(0);
  const restored = canvases[farCount]!;
  expect(restored).not.toBe(original);
  expect([restored.width, restored.height]).toEqual(size);
  expect(restored.paint.moveTo.mock.calls).toEqual(paths.move);
  expect(restored.paint.lineTo.mock.calls).toEqual(paths.line);
  painter.dispose();
});
