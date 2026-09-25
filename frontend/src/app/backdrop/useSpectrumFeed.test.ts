import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSpectrumFeed, type SpectrumFrame } from "./useSpectrumFeed";

const { spectrum } = vi.hoisted(() => ({ spectrum: vi.fn() }));
vi.mock("../../services/audioClient", () => ({ audioClient: { spectrum } }));
vi.mock("../ServicesContext", () => ({ useServices: () => ({ audio: { kind: "ready" } }) }));

beforeEach(() => {
  vi.useFakeTimers();
  spectrum.mockReset();
});
afterEach(() => vi.useRealTimers());

it("ignores an in-flight spectrum after polling is disabled", async () => {
  let resolve: (bands: number[]) => void = () => {};
  spectrum.mockImplementation(() => new Promise<number[]>(done => { resolve = done; }));
  const onFrame = vi.fn();
  const { rerender } = renderHook(({ enabled }) => useSpectrumFeed(enabled, onFrame), {
    initialProps: { enabled: true },
  });
  rerender({ enabled: false });
  resolve([1]);
  await vi.advanceTimersByTimeAsync(200);
  expect(onFrame).not.toHaveBeenCalled();
  expect(spectrum).toHaveBeenCalledOnce();
});

it("keeps one IPC request in flight across callback changes and restarts", async () => {
  const replies: Array<(bands: number[]) => void> = [];
  spectrum.mockImplementation(() => new Promise<number[]>(done => replies.push(done)));
  const onFrame = vi.fn();
  const { rerender } = renderHook(({ enabled, callback }: { enabled: boolean; callback: (frame: SpectrumFrame) => void }) => useSpectrumFeed(enabled, callback), {
    initialProps: { enabled: true, callback: vi.fn() },
  });
  rerender({ enabled: false, callback: onFrame });
  rerender({ enabled: true, callback: onFrame });
  await vi.advanceTimersByTimeAsync(200);
  expect(spectrum).toHaveBeenCalledOnce();
  replies[0]?.([1]);
  await vi.advanceTimersByTimeAsync(50);
  expect(spectrum).toHaveBeenCalledTimes(2);
  replies[1]?.([0.1]);
  await vi.advanceTimersByTimeAsync(0);
  expect(onFrame).toHaveBeenCalledOnce();
});
