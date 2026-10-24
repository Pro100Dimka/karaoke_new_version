import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelDto,
  ProcessingJobDto,
} from "../../../../../../contracts/models";
import {
  createAiSettingsSession,
  aiSettingsSessionFor,
} from "../aiSettingsSession";

const model = {
  id: "model",
  version: "1",
  purpose: "Separation",
  state: "not-installed",
  sizeBytes: 10,
} as ModelDto;
const job = (
  state: ProcessingJobDto["state"],
  progress = 0,
): ProcessingJobDto =>
  ({
    id: "job",
    type: "ModelDownload",
    stage: "Download",
    state,
    progress,
  }) as ProcessingJobDto;
const setup = () => {
  vi.useFakeTimers();
  const backend = {
    downloadModel: vi.fn().mockResolvedValue(job("processing")),
    getJob: vi.fn().mockResolvedValue(job("completed", 1)),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    diagnostics: vi.fn().mockResolvedValue({ storage: { free: 1000 } }),
    getAiProcessingSettings: vi
      .fn()
      .mockResolvedValue({ processingBackend: "Local" }),
    updateAiProcessingSettings: vi
      .fn()
      .mockResolvedValue({ processingBackend: "Local" }),
  };
  const desktop = {
    getStorageRoot: vi.fn().mockResolvedValue("D:/data"),
    pickStorageFolder: vi.fn().mockResolvedValue(null),
    setStorageRoot: vi.fn().mockResolvedValue(undefined),
  };
  const events = {
    next: vi.fn(
      (_id: string, ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ),
  };
  return {
    backend,
    desktop,
    events,
    store: createAiSettingsSession(backend, desktop, events),
  };
};
afterEach(() => vi.useRealTimers());

describe("model download ownership", () => {
  it("continues the same job while the tab unsubscribes and subscribes again", async () => {
    const { backend, desktop, events } = setup();
    const store = aiSettingsSessionFor(backend, desktop, events);
    const first = vi.fn();
    const unsubscribe = store.subscribe(first);
    const completion = store.start(model);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().jobs.model?.id).toBe("job");
    unsubscribe();
    const before = first.mock.calls.length;
    const reopened = aiSettingsSessionFor(backend, desktop, events);
    expect(reopened).toBe(store);
    const second = vi.fn();
    const close = reopened.subscribe(second);
    await vi.runAllTimersAsync();
    await completion;
    expect(first).toHaveBeenCalledTimes(before);
    expect(second).toHaveBeenCalled();
    expect(reopened.getSnapshot().jobs.model?.state).toBe("completed");
    expect(backend.downloadModel).toHaveBeenCalledOnce();
    close();
  });

  it("deduplicates clicks before the download request has returned", async () => {
    const { backend, store } = setup();
    const first = store.start(model);
    const second = store.start(model);
    expect(second).toBe(first);
    expect(store.getSnapshot().pendingDownloads.has(model.id)).toBe(true);
    await vi.runAllTimersAsync();
    await first;
    expect(backend.downloadModel).toHaveBeenCalledOnce();
    expect(store.getSnapshot().pendingDownloads.size).toBe(0);
  });

  it("recovers from a transient read failure without losing the active job", async () => {
    const { backend, store } = setup();
    backend.getJob.mockRejectedValueOnce(new Error("temporary disconnect"));
    const completion = store.start(model);
    await vi.runAllTimersAsync();
    expect((await completion).state).toBe("completed");
    expect(backend.getJob).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().downloadErrors).toEqual({});
  });

  it("stops repeated failures and lets Retry resume the existing job", async () => {
    const { backend, events, store } = setup();
    const error = new Error("offline");
    backend.getJob.mockRejectedValue(error);
    const failure = store.start(model).catch((reason: unknown) => reason);
    await vi.runAllTimersAsync();
    expect(await failure).toBe(error);
    expect(backend.getJob).toHaveBeenCalledTimes(3);
    expect(events.next.mock.calls.map((call) => call[1])).toEqual([
      700, 1400, 2800,
    ]);
    expect(store.getSnapshot().downloadErrors.model).toBe(error);
    expect(store.getSnapshot().jobs.model?.id).toBe("job");
    backend.getJob.mockResolvedValue(job("completed", 1));
    await store.refresh();
    await vi.runAllTimersAsync();
    expect(store.getSnapshot().jobs.model?.state).toBe("completed");
    expect(store.getSnapshot().downloadErrors).toEqual({});
    expect(backend.downloadModel).toHaveBeenCalledOnce();
  });

  it("can retry a synchronously rejected start instead of retaining a dead in-flight entry", async () => {
    const { backend, store } = setup();
    backend.downloadModel.mockImplementationOnce(() => {
      throw new Error("bridge unavailable");
    });
    await expect(store.start(model)).rejects.toThrow("bridge unavailable");
    const retry = store.start(model);
    await vi.runAllTimersAsync();
    expect((await retry).state).toBe("completed");
    expect(backend.downloadModel).toHaveBeenCalledTimes(2);
  });
});
