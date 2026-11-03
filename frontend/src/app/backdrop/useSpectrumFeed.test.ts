import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createPercussionReaction,
  toSpectrumFrame,
  useSpectrumFeed,
  type SpectrumFrame,
} from './useSpectrumFeed';

const { observeSpectrum } = vi.hoisted(() => ({ observeSpectrum: vi.fn() }));
vi.mock('../../services/audioClient', () => ({ audioClient: { observeSpectrum } }));
vi.mock('../../providers/store', () => ({
  store: { application: { services: { audio: { kind: 'ready' } } } },
}));

beforeEach(() => {
  vi.useFakeTimers();
  observeSpectrum.mockReset();
});
afterEach(() => vi.useRealTimers());

it('creates distinct kick and snare impulses and lets both decay smoothly', () => {
  const reaction = createPercussionReaction();
  reaction.next(Array(18).fill(0));
  const kick = reaction.next([0.9, 0.8, 0.7, 0.5, ...Array(14).fill(0)]);
  expect(kick.kick).toBeGreaterThan(0.5);
  expect(kick.snare).toBeLessThan(kick.kick);

  const snareBands = Array(18).fill(0);
  for (let index = 4; index <= 13; index += 1) snareBands[index] = 0.8;
  const snare = reaction.next(snareBands);
  expect(snare.snare).toBeGreaterThan(0.5);

  const release = reaction.next(Array(18).fill(0));
  expect(release.pulse).toBeGreaterThan(0);
  expect(release.pulse).toBeLessThanOrEqual(Math.max(kick.pulse, snare.pulse));
});

it('uses the final spectrum as a compatibility fallback for an older AudioService', () => {
  expect(toSpectrumFrame([0.7, 0.5], []).backingBands).toEqual([0.7, 0.5]);
});

it('ignores held tones and isolated harmonic movement but reacts to a broadband drum attack', () => {
  const reaction = createPercussionReaction();
  const held = Array(18).fill(0.3);
  reaction.next(held);
  for (let frame = 0; frame < 60; frame++) reaction.next(held, 1 / 60);
  const harmonic = [...held];
  harmonic[1] = 0.6;
  harmonic[10] = 0.6;
  expect(reaction.next(harmonic, 1 / 60).pulse).toBeLessThan(0.01);
  reaction.next(held, 0.1);
  const cymbal = [...held];
  for (let band = 9; band < 18; band++) cymbal[band] = 0.6;
  expect(reaction.next(cymbal, 0.1).snare).toBeLessThan(0.01);
  reaction.next(held, 0.1);
  const kick = [...held];
  for (let band = 0; band < 5; band++) kick[band] = 0.55;
  expect(reaction.next(kick, 0.1).kick).toBeGreaterThan(0.5);
  reaction.next(held, 0.1);
  const snare = [...held];
  for (let band = 5; band < 17; band++) snare[band] = 0.5;
  expect(reaction.next(snare, 0.1).snare).toBeGreaterThan(0.5);
});

it('unsubscribes when disabled', () => {
  const stop = vi.fn();
  observeSpectrum.mockReturnValue(stop);
  const callback = vi.fn();
  const { rerender } = renderHook(({ enabled }) => useSpectrumFeed(enabled, callback), {
    initialProps: { enabled: true },
  });
  rerender({ enabled: false });
  expect(stop).toHaveBeenCalledOnce();
  expect(observeSpectrum).toHaveBeenCalledOnce();
});

it('retains only one active subscription when callbacks change', () => {
  let active = 0;
  observeSpectrum.mockImplementation(() => {
    active++;
    return () => { active--; };
  });
  const { rerender, unmount } = renderHook(({ callback }: {
    callback: (frame: SpectrumFrame) => void;
  }) => useSpectrumFeed(true, callback), { initialProps: { callback: vi.fn() } });
  rerender({ callback: vi.fn() });
  expect(active).toBe(1);
  unmount();
  expect(active).toBe(0);
});

it('reduces the silent feed rate and restores the full rate when sound returns', async () => {
  let deliver: (value: { bands: number[]; backingBands: number[] }) => void = () => {};
  observeSpectrum.mockImplementation(onValue => { deliver = onValue; return vi.fn(); });
  const onFrame = vi.fn();
  renderHook(() => useSpectrumFeed(true, onFrame));
  expect(observeSpectrum).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Function), 50);
  await vi.advanceTimersByTimeAsync(1100);
  act(() => deliver({ bands: [0], backingBands: [0] }));
  expect(observeSpectrum).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Function), 250);
  act(() => deliver({ bands: [0.5], backingBands: [0.5] }));
  expect(observeSpectrum).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Function), 50);
  expect(onFrame).toHaveBeenCalledTimes(2);
});
