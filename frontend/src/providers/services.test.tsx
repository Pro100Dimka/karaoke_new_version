import { autorun } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subscribeServices } from "./services";
import { store } from "./store";

const { audio, python } = vi.hoisted(() => ({ audio: vi.fn(), python: vi.fn() }));
vi.mock("../services/audioClient", () => ({ audioClient: { health: audio } }));
vi.mock("../services/pythonClient", () => ({ pythonClient: { health: python } }));
let stop = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  audio.mockReset().mockResolvedValue({ status: "ready", version: "1", instanceId: "audio-first" });
  python.mockReset().mockResolvedValue({ status: "ready", version: "1", apiVersion: 1, instanceId: "first" });
});
afterEach(() => { stop(); vi.useRealTimers(); });

it("does not notify store consumers for unchanged health replies", async () => {
  stop = subscribeServices();
  await vi.advanceTimersByTimeAsync(0);
  const changed = vi.fn();
  const dispose = autorun(() => changed(store.application.services.python, store.application.services.audio));
  try {
    const probes = python.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(python).toHaveBeenCalledTimes(probes + 3);
    expect(changed).toHaveBeenCalledOnce();
  } finally { dispose(); }
});

it.each(["python", "audio"] as const)("invalidates %s assets after a service restart", async (service) => {
  stop = subscribeServices();
  await vi.advanceTimersByTimeAsync(0);
  const epoch = service === "python" ? "pythonEpoch" : "audioEpoch";
  expect(store.application.services[epoch]).toBe(0);
  const health = service === "python" ? python : audio;
  health.mockResolvedValue({ status: "ready", version: "1", apiVersion: 1, instanceId: "second" });
  await store.application.services.probe();
  expect(store.application.services[epoch]).toBe(1);
  await store.application.services.probe();
  expect(store.application.services[epoch]).toBe(1);
});

it("does not accumulate requests or publish a late reply after unsubscribe", async () => {
  let reply!: (value: unknown) => void;
  audio.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
  stop = subscribeServices();
  void store.application.services.probe();
  await vi.advanceTimersByTimeAsync(15000);
  expect(audio).toHaveBeenCalledOnce();
  expect(python).toHaveBeenCalledOnce();
  stop();
  reply({ status: "ready" });
  await vi.advanceTimersByTimeAsync(4000);
  expect(store.application.services.audio.kind).toBe("starting");
  expect(audio).toHaveBeenCalledOnce();
});
