import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PitchFrame } from '../../../contracts/models';
import type { LyricLine } from '../karaokeLyrics';
import { useShowEngine } from './ShowLayers';
import { ShowEngine } from './showEngine';
import { StageFxRenderer } from './stageFxRenderer';
import { CanvasLightRenderer } from './gl/canvasLightRenderer';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  'failed',
  'error',
  'messageerror',
  'constructor',
  'transfer',
  'post',
  'frame',
])('restores stage effects on the main thread after worker %s', (failure) => {
  vi.stubGlobal(
    'OffscreenCanvas',
    vi.fn(function () {
      return { width: 1, height: 1 };
    }),
  );
  let draw: FrameRequestCallback | undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    draw = callback;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  const worker = {
    onmessage: (_event: { data: { type: string } }) => undefined,
    onerror: () => undefined,
    onmessageerror: () => undefined,
    terminate: vi.fn(),
    postMessage: vi.fn((message: { type: string }) => {
      if (
        failure === 'post' ||
        (failure === 'frame' && message.type === 'frame')
      )
        throw new Error('Worker send failed');
    }),
  };
  vi.stubGlobal(
    'Worker',
    vi.fn(function () {
      if (failure === 'constructor') throw new Error('Worker unavailable');
      return worker;
    }),
  );
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.className = 'stageCanvas';
  canvas.style.opacity = '0.8';
  canvas.transferControlToOffscreen = vi.fn(() => {
    if (failure === 'transfer') throw new Error('Transfer failed');
    return new OffscreenCanvas(1, 1);
  });
  const paint = vi
    .spyOn(CanvasLightRenderer, 'create')
    .mockReturnValue(undefined);
  host.append(canvas);
  const renderer = new StageFxRenderer(canvas, new ShowEngine(), host);
  try {
    const notify = {
      failed: () => worker.onmessage({ data: { type: 'failed' } }),
      error: () => worker.onerror(),
      messageerror: () => worker.onmessageerror(),
      frame: () => {
        worker.onmessage({ data: { type: 'ready' } });
        renderer.start();
        draw?.(0);
      },
    };
    if (failure in notify) notify[failure as keyof typeof notify]();
    const replacement = host.querySelector('canvas.stageCanvas');
    expect(replacement).not.toBe(canvas);
    expect(replacement?.getAttribute('style')).toContain('opacity: 0.8');
    expect(paint).toHaveBeenCalledWith(replacement);
    if (failure !== 'constructor')
      expect(worker.terminate).toHaveBeenCalledOnce();
    worker.onmessage({ data: { type: 'ready' } });
    expect(paint).toHaveBeenCalledOnce();
  } finally {
    renderer.stop();
  }
  expect(host.querySelector('canvas')).toBeNull();
});

vi.mock('../../../app/backdrop/spectrumEvents', () => ({
  subscribeSpectrum: () => () => undefined,
}));

it('resets a new room performance without scoring buffered frames from the previous run', () => {
  const notes = [{ id: 'note', start: 0, end: 1, pitch: 69 }];
  const lines: LyricLine[] = [];
  const settings = { intensity: 'full' as const, reducedMotion: true };
  const { result, rerender } = renderHook(
    ({
      performanceId,
      pitchFrames,
    }: {
      performanceId: number;
      pitchFrames: PitchFrame[];
    }) =>
      useShowEngine({
        notes,
        lines,
        settings,
        position: 0,
        playing: true,
        pitchHz: undefined,
        pitchFrames,
        ignoreSilence: true,
        performanceId,
      }),
    { initialProps: { performanceId: 1, pitchFrames: [] as PitchFrame[] } },
  );
  const frames: PitchFrame[] = [1, 2].map((sequence) => ({
    sequence,
    epoch: 1,
    positionSeconds: (sequence - 0.5) * 0.05,
    durationSeconds: 0.05,
    pitchHz: 440,
    audioActive: true,
  }));
  rerender({ performanceId: 1, pitchFrames: frames });
  expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.1);
  rerender({ performanceId: 2, pitchFrames: frames });
  expect(result.current.noteScore.assessedPitchSeconds).toBe(0);
  rerender({
    performanceId: 2,
    pitchFrames: [
      ...frames,
      { ...frames[1]!, sequence: 3, positionSeconds: 0.125 },
    ],
  });
  expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.05);
});

it('assigns show phrases without rescanning every note for every lyric line', () => {
  let wordReads = 0;
  const notes = Array.from({ length: 2000 }, (_, index) => ({
    id: `n${index}`,
    get wordId() {
      wordReads++;
      return `w${index}`;
    },
    pitch: 60,
    start: index,
    end: index + 0.5,
  }));
  const lines: LyricLine[] = Array.from({ length: 400 }, (_, line) => ({
    start: line * 5,
    end: line * 5 + 4.5,
    words: Array.from({ length: 5 }, (_, word) => ({
      id: `w${line * 5 + word}`,
      text: 'word',
      start: line * 5 + word,
      end: line * 5 + word + 0.5,
    })),
  }));
  const load = vi
    .spyOn(ShowEngine.prototype, 'load')
    .mockImplementation(() => {});
  renderHook(() =>
    useShowEngine({
      notes,
      lines,
      settings: { intensity: 'full', reducedMotion: false },
      position: 0,
      playing: false,
      pitchHz: undefined,
    }),
  );
  const phrases = load.mock.calls[0]?.[1];
  expect(phrases?.[0]?.noteIds).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  expect(phrases?.at(-1)?.noteIds).toEqual([
    'n1995',
    'n1996',
    'n1997',
    'n1998',
    'n1999',
  ]);
  expect(wordReads).toBeLessThanOrEqual(notes.length * 2);
});

it('keeps phrase note order and repeated word membership when building the show', () => {
  const word = { id: 'w1', text: 'word', start: 1, end: 2 };
  const lines: LyricLine[] = [
    { start: 1, end: 2, words: [word, word, { ...word, id: 'w2' }] },
    { start: 3, end: 4, words: [{ ...word, start: 3, end: 4 }] },
  ];
  const notes = [
    { id: 'first', wordId: 'w2', start: 1, end: 1.5, pitch: 60 },
    { id: 'second', wordId: 'w1', start: 1.5, end: 2, pitch: 60 },
    { id: 'orphan', wordId: 'missing', start: 2, end: 3, pitch: 60 },
  ];
  const load = vi
    .spyOn(ShowEngine.prototype, 'load')
    .mockImplementation(() => {});
  renderHook(() =>
    useShowEngine({
      notes,
      lines,
      settings: { intensity: 'full', reducedMotion: false },
      position: 0,
      playing: false,
      pitchHz: undefined,
    }),
  );
  expect(load.mock.calls[0]?.[1]).toEqual([
    { start: 1, end: 2, noteIds: ['first', 'second'] },
    { start: 3, end: 4, noteIds: ['second'] },
  ]);
});

it.each([false, true])(
  'scores final captured voice once after pause or EOF (earlier capture: %s)',
  (earlierCapture) => {
    const notes = [{ id: 'note', start: 0, end: 1, pitch: 69 }];
    const lines: LyricLine[] = [];
    const settings = { intensity: 'full' as const, reducedMotion: true };
    const first: PitchFrame = {
      sequence: 1,
      epoch: 1,
      positionSeconds: 0.025,
      durationSeconds: 0.05,
      pitchHz: 440,
      audioActive: true,
    };
    const { result, rerender } = renderHook(
      ({ playing, frames }: { playing: boolean; frames: PitchFrame[] }) =>
        useShowEngine({
          notes,
          lines,
          settings,
          position: 0.2,
          pitchHz: undefined,
          playing,
          pitchFrames: frames,
          ignoreSilence: true,
          performanceId: 1,
        }),
      {
        initialProps: { playing: true, frames: earlierCapture ? [first] : [] },
      },
    );
    const last = { ...first, sequence: 2, positionSeconds: 0.075 };
    const silence = {
      ...first,
      sequence: 3,
      positionSeconds: 0.125,
      pitchHz: undefined,
      audioActive: false,
    };
    rerender({ playing: false, frames: [first, last, silence] });
    expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.1);
    expect(result.current.state.playing).toBe(false);
    rerender({ playing: false, frames: [first, last, silence] });
    expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.1);
    rerender({ playing: false, frames: [{ ...last, epoch: 2, sequence: 4 }] });
    expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.1);
    rerender({
      playing: true,
      frames: [{ ...last, epoch: 2, sequence: 4, positionSeconds: 0.175 }],
    });
    expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.15);
    rerender({
      playing: false,
      frames: [{ ...last, sequence: 5, positionSeconds: 0.225 }],
    });
    expect(result.current.noteScore.assessedPitchSeconds).toBeCloseTo(0.15);
  },
);
