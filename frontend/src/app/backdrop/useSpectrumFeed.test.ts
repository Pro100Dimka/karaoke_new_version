import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPercussionReaction, percussionLevel, toSpectrumFrame, useSpectrumFeed, type SpectrumFrame } from "./useSpectrumFeed";

const { spectrum } = vi.hoisted(() => ({ spectrum: vi.fn() }));
vi.mock("../../services/audioClient", () => ({ audioClient: { spectrum } }));
vi.mock("../ServicesContext", () => ({ useServices: () => ({ audio: { kind: "ready" } }) }));

beforeEach(() => {
  vi.useFakeTimers();
  spectrum.mockReset();
});
afterEach(() => vi.useRealTimers());

it("responds to bass, drums and bright percussion bands", () => {
  expect(percussionLevel([0.8, 0.8, 0.8])).toBeGreaterThan(0.7);
  expect(percussionLevel([0, 0, 0, 0.8, 0.8, 0.8])).toBeGreaterThan(0.6);
  expect(percussionLevel([0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0.8, 0.8])).toBeGreaterThan(0.5);
});

it("creates distinct kick and snare impulses and lets both decay smoothly", () => {
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

it("uses the final spectrum as a compatibility fallback for an older AudioService", () => {
  expect(toSpectrumFrame([0.7, 0.5], []).backingBands).toEqual([0.7, 0.5]);
});

it("ignores an in-flight spectrum after polling is disabled", async () => {
  let resolve: (value: { bands: number[]; backingBands: number[] }) => void = () => {};
  spectrum.mockImplementation(() => new Promise<{ bands: number[]; backingBands: number[] }>(done => { resolve = done; }));
  const onFrame = vi.fn();
  const { rerender } = renderHook(({ enabled }) => useSpectrumFeed(enabled, onFrame), {
    initialProps: { enabled: true },
  });
  rerender({ enabled: false });
  resolve({ bands: [1], backingBands: [0.5] });
  await vi.advanceTimersByTimeAsync(200);
  expect(onFrame).not.toHaveBeenCalled();
  expect(spectrum).toHaveBeenCalledOnce();
});

it("keeps one IPC request in flight across callback changes and restarts", async () => {
  const replies: Array<(value: { bands: number[]; backingBands: number[] }) => void> = [];
  spectrum.mockImplementation(() => new Promise<{ bands: number[]; backingBands: number[] }>(done => replies.push(done)));
  const onFrame = vi.fn();
  const { rerender } = renderHook(({ enabled, callback }: { enabled: boolean; callback: (frame: SpectrumFrame) => void }) => useSpectrumFeed(enabled, callback), {
    initialProps: { enabled: true, callback: vi.fn() },
  });
  rerender({ enabled: false, callback: onFrame });
  rerender({ enabled: true, callback: onFrame });
  await vi.advanceTimersByTimeAsync(200);
  expect(spectrum).toHaveBeenCalledOnce();
  replies[0]?.({ bands: [1], backingBands: [0.5] });
  await vi.advanceTimersByTimeAsync(50);
  expect(spectrum).toHaveBeenCalledTimes(2);
  replies[1]?.({ bands: [0.1], backingBands: [0.05] });
  await vi.advanceTimersByTimeAsync(0);
  expect(onFrame).toHaveBeenCalledOnce();
});
