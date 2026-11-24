import { afterEach, expect, it, vi } from 'vitest';
import { RollNotePainter } from './rollFxNotes';
import type {
  Geometry,
  PaintContext,
  RollLayout,
  RollView,
} from './rollFxPaint';
import { ShowEngine } from './showEngine';
import type { ShowNote } from './performanceScoring';
import { RollFxNoteIndex } from './rollFxNoteIndex';

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
      roundRect: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    },
    { get: (target, key) => Reflect.get(target, key) ?? vi.fn() },
  );

const setup = (source?: readonly ShowNote[]) => {
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
    notes:
      source ??
      Array.from({ length: 300 }, (_, index) => ({
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
  const engine = new ShowEngine();
  const painter = new RollNotePainter(engine, layout);
  const context = brush();
  const paint = (position: number, scale = 2, now = position * 1000) => {
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
      { ...view },
      geometry,
      now,
    );
  };
  return { painter, canvases, paint, view, engine, context, layout };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

it('rebuilds the lookup and releases old textures when a new note array changes timing or pitch', () => {
  const { painter, canvases, paint, view, context } = setup();
  paint(0);
  const previous = [...canvases];
  view.notes = [
    {
      id: 'replacement',
      start: 0.4,
      end: 1.4,
      pitch: 74,
      contour: [
        [0, 0, 1],
        [0.5, -2, 1],
        [1, 0, 1],
      ],
    },
  ];
  context.drawImage.mockClear();
  paint(0);
  expect(previous.every((canvas) => canvas.width === 0)).toBe(true);
  expect(context.drawImage).toHaveBeenCalledTimes(1);
  const [texture, left, top] = context.drawImage.mock.calls[0]!;
  expect(texture).not.toBe(previous[0]);
  expect(left).toBeCloseTo(262);
  expect(top).toBeCloseTo(82);
  view.notes = [];
  paint(0);
  expect(canvases.every((canvas) => canvas.width === 0)).toBe(true);
  painter.dispose();
});

it('keeps repeated sharp and bloom paints independent of distant notes in a long song', () => {
  const reads = { start: 0, end: 0, id: 0, contour: 0 };
  const source = Array.from({ length: 10000 }, (_, index): ShowNote => ({
    get id() {
      reads.id++;
      return `note-${index}`;
    },
    get start() {
      reads.start++;
      return index * 0.2;
    },
    get end() {
      reads.end++;
      return index * 0.2 + 0.15;
    },
    pitch: 60,
    get contour() {
      reads.contour++;
      return contour;
    },
  }));
  const contour = [
    [0, 0, 1],
    [0.5, 2, 1],
    [1, 0, 1],
  ] as const;
  const { painter, paint } = setup(source);
  paint(1800);
  paint(1800, 0.66);
  reads.start = reads.end = reads.id = reads.contour = 0;
  for (let frame = 1; frame <= 20; frame++) {
    paint(1800 + frame / 60);
    paint(1800 + frame / 60, 0.66);
  }
  expect.soft(reads.start).toBeLessThan(20_000);
  expect.soft(reads.id).toBeLessThan(1000);
  expect.soft(reads.contour).toBeLessThan(20_000);
  painter.dispose();
});

it('preserves full-scan paint calls for unsorted overlaps, edge contours, duplicate IDs, effects, zoom and seek', () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const source: ShowNote[] = Array.from({ length: 320 }, (_, index) => ({
    id: `distant-${index}`,
    start: 1000 + index,
    end: 1000.5 + index,
    pitch: 60,
  }));
  source[0] = {
    id: 'long',
    start: 0,
    end: 120,
    pitch: 61,
    contour: [
      [0, 0, 1],
      [0.5, 2, 1],
      [1, 0, 1],
    ],
  };
  source[127] = {
    id: 'duplicate',
    start: 10.2,
    end: 10.8,
    pitch: 63,
    contour: [
      [0, 0, 1],
      [0.5, 3, 0.3],
      [1, 1, 1],
    ],
  };
  source[128] = {
    id: 'duplicate',
    start: 9,
    end: 11,
    pitch: 70,
    contour: [
      [0, -1, 1],
      [1, 2, 1],
    ],
  };
  source[129] = {
    id: 'left-edge',
    start: 7.98,
    end: 8.001,
    pitch: 62,
    contour: [
      [0, 0, 1],
      [1, 1, 1],
    ],
  };
  source[255] = {
    id: 'right-edge',
    start: 16.001,
    end: 17,
    pitch: 80,
    contour: [
      [0, 0, 1],
      [1, 3, 1],
    ],
  };
  source[319] = {
    id: 'upcoming',
    start: 10.45,
    end: 10.7,
    pitch: 59,
    contour: [
      [0, 0, 1],
      [1, -1, 1],
    ],
  };

  const run = () => {
    const fixture = setup(source);
    const { painter, paint, view, engine, context } = fixture;
    view.position = 10.3;
    for (const note of [source[128]!, source[0]!]) {
      for (const position of [10.2, 10.25]) {
        engine.state.live = {
          note,
          position,
          target: note.pitch,
          charge: 1,
          accuracy: 0.95,
          deviation: 0,
        };
        painter.record(view);
      }
    }
    engine.state.live = undefined;
    painter.onCommand({
      kind: 'noteGlow',
      at: 0,
      strength: 0.97,
      noteId: 'duplicate',
    });
    painter.onCommand({
      kind: 'noteRing',
      at: 0,
      strength: 1,
      noteId: 'duplicate',
    });
    const snapshots: unknown[] = [];
    for (const [position, span, low, high] of [
      [10, 8, 48, 84],
      [10.35, 8, 48, 84],
      [10.35, 2, 56, 76],
      [1050, 20, 48, 84],
      [10, 8, 48, 84],
    ] as const) {
      Object.assign(view, { position, span, low, high });
      painter.expire(100);
      painter.record(view);
      for (const scale of [2, 0.66]) {
        paint(position, scale, 100);
        snapshots.push({
          paths: {
            move: context.moveTo.mock.calls.map((call) => [...call]),
            line: context.lineTo.mock.calls.map((call) => [...call]),
            upcoming: context.roundRect.mock.calls.map((call) => [...call]),
            stars: context.createRadialGradient.mock.calls.map((call) => [
              ...call,
            ]),
          },
          textures: context.drawImage.mock.calls.map(
            ([canvas, ...coordinates]) => ({
              width: canvas.width,
              height: canvas.height,
              move: canvas.paint.moveTo.mock.calls.map((call: unknown[]) => [
                ...call,
              ]),
              line: canvas.paint.lineTo.mock.calls.map((call: unknown[]) => [
                ...call,
              ]),
              coordinates,
            }),
          ),
        });
        context.moveTo.mockClear();
        context.lineTo.mockClear();
        context.roundRect.mockClear();
        context.createRadialGradient.mockClear();
        context.drawImage.mockClear();
      }
    }
    const retained = fixture.canvases.reduce(
      (sum, canvas) => sum + canvas.width * canvas.height,
      0,
    );
    painter.dispose();
    return { snapshots, retained };
  };
  const indexed = run();
  // The broad phase may select every source note; the established exact paint
  // predicates remain the reference for culling, duplicate IDs and paint order.
  for (const method of ['overlapping', 'starting', 'matchingIds'] as const)
    vi.spyOn(RollFxNoteIndex.prototype, method).mockImplementation(function (
      this: RollFxNoteIndex,
    ) {
      return this.source;
    });
  vi.spyOn(RollFxNoteIndex.prototype, 'first').mockImplementation(function (
    this: RollFxNoteIndex,
    id,
  ) {
    return this.source.find((note) => note.id === id);
  });
  expect(run()).toEqual(indexed);
});
