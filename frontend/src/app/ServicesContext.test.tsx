import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServicesProvider, useServices } from "./ServicesContext";

const { audio, python } = vi.hoisted(() => ({ audio: vi.fn(), python: vi.fn() }));
vi.mock("../services/audioClient", () => ({ audioClient: { health: audio } }));
vi.mock("../services/pythonClient", () => ({ pythonClient: { health: python } }));

beforeEach(() => {
  vi.useFakeTimers();
  audio.mockReset();
  python.mockReset();
});
afterEach(() => vi.useRealTimers());

it("invalidates cached assets when a backend restarts between health probes", async () => {
  audio.mockResolvedValue({ status: "ready", version: "1" });
  python.mockResolvedValue({ status: "ready", version: "1", apiVersion: 1, instanceId: "first" });
  const { result, unmount } = renderHook(useServices, { wrapper: ServicesProvider });
  await act(async () => {});
  expect(result.current.pythonEpoch).toBe(0);
  python.mockResolvedValue({ status: "ready", version: "1", apiVersion: 1, instanceId: "second" });
  await act(async () => { await result.current.probe(); });
  expect(result.current.pythonEpoch).toBe(1);
  await act(async () => { await result.current.probe(); });
  expect(result.current.pythonEpoch).toBe(1);
  unmount();
});

it("does not accumulate health requests while services are slow", async () => {
  let reply: () => void = () => {};
  audio.mockImplementation(() => new Promise(resolve => { reply = () => resolve({ status: "ready" }); }));
  python.mockResolvedValue({ status: "ready", version: "1", apiVersion: 1 });
  const { result } = renderHook(useServices, { wrapper: ServicesProvider });
  await act(async () => {
    void result.current.probe();
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(audio).toHaveBeenCalledOnce();
  expect(python).toHaveBeenCalledOnce();
  await act(async () => {
    reply();
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(result.current.audio.kind).toBe("ready");
  expect(audio).toHaveBeenCalledTimes(2);
});
