import { renderHook } from '@testing-library/react';
import { useShowEngine } from './ShowLayers';
import { describe, expect, it } from 'vitest';
import { ShowEngine } from './showEngine';

describe('lyrics rhythm', () => {
  it('ignores weak drum rolls between accents without silencing a quieter passage', () => {
    const engine = new ShowEngine();
    engine.load([], [], true, undefined, [
      [1, 1],
      [1.12, 0.3],
      [1.24, 0.35],
      [1.36, 0.25],
      [1.5, 0.9],
      [5, 0.3],
      [5.5, 0.35],
    ]);
    for (const position of [1, 1.5, 5, 5.5]) {
      engine.advance(position * 1000, position, undefined, true);
      expect(engine.state.musicBeat).toBeGreaterThan(0.25);
    }
    for (const position of [1.12, 1.24, 1.36, 1.24]) {
      engine.advance(position * 1000, position, undefined, true);
      expect(engine.state.musicBeat).toBe(0);
    }
  });

  it('keeps the hit crisp instead of swelling through the next tenth of a second', () => {
    const engine = new ShowEngine();
    engine.load([], [], true, undefined, [[1, 1]]);
    engine.advance(0, 1, undefined, true);
    expect(engine.state.musicBeat).toBe(1);
    engine.advance(16, 1.016, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.45);
    engine.advance(64, 1.064, undefined, true);
    expect(engine.state.musicBeat).toBeLessThan(0.15);
    engine.advance(100, 1.1, undefined, true);
    expect(engine.state.musicBeat).toBe(0);
  });

  it('keeps a strong short hit at a normal animation-frame interval', () => {
    const engine = new ShowEngine();
    engine.load([], [], true, undefined, [[1, 1]]);
    engine.advance(0, 0.99, undefined, true);
    engine.advance(16, 1.016, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.45);
  });

  it('does not bounce to arbitrary backing sounds without isolated rhythm evidence', () => {
    const engine = new ShowEngine();
    engine.load([], []);
    engine.advance(1000, 0.4, undefined, true);
    engine.hear(Array(18).fill(0.8), 1020);
    engine.advance(1020, 0.42, undefined, true);
    expect(engine.state.musicBeat).toBe(0);
  });

  it('follows bass and drum onsets at the source position, including seek and pause', () => {
    const engine = new ShowEngine();
    engine.load([], [], true, undefined, [
      [0.5, 1],
      [1, 0.8],
    ]);
    engine.advance(1000, 0.48, undefined, true);
    engine.advance(1020, 0.5, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.7);
    engine.advance(1040, 0.1, undefined, true);
    expect(engine.state.musicBeat).toBe(0);
    engine.advance(1060, 1, undefined, true);
    expect(engine.state.musicBeat).toBeGreaterThan(0.5);
    engine.advance(1080, 1, undefined, false);
    expect(engine.state.musicBeat).toBe(0);
  });
});

it('does not let delayed microphone frames replace the current backing-track beat', () => {
  const { result } = renderHook(() =>
    useShowEngine({
      notes: [],
      lines: [],
      rhythm: [[1, 1]],
      position: 1.016,
      playing: true,
      pitchHz: 220,
      settings: { intensity: 'full', reducedMotion: false },
      pitchFrames: [
        {
          epoch: 1,
          sequence: 1,
          positionSeconds: 0.95,
          durationSeconds: 0.02,
          pitchHz: 220,
          confidence: 0.95,
          audioActive: true,
        },
      ],
    }),
  );
  expect(result.current.voiceHistory.at(-1)?.position).toBe(0.95);
  expect(result.current.state.musicBeat).toBeGreaterThan(0.45);
});
