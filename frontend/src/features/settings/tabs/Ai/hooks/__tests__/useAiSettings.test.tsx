import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiSettings } from "../useAiSettings";

const makeBackend = () => ({
  listModels: vi.fn().mockResolvedValue([]),
  diagnostics: vi.fn().mockResolvedValue({ storage: { free: 1000 } }),
  getAiProcessingSettings: vi
    .fn()
    .mockResolvedValue({ processingBackend: "Local" }),
  updateAiProcessingSettings: vi
    .fn()
    .mockResolvedValue({ processingBackend: "Kaggle" }),
  downloadModel: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn().mockResolvedValue(undefined),
});
const makeDesktop = () => ({
  getStorageRoot: vi.fn().mockResolvedValue("D:/data"),
  pickStorageFolder: vi.fn().mockResolvedValue("E:/data"),
  setStorageRoot: vi.fn().mockResolvedValue(undefined),
});
const dependencies = vi.hoisted(() => ({
  backend: {} as ReturnType<typeof makeBackend>,
  desktop: {} as ReturnType<typeof makeDesktop>,
  events: { next: vi.fn() },
  notify: vi.fn(),
}));
vi.mock("../../../../../../app/SettingsProvider", () => ({
  useSettingsBackend: () => dependencies.backend,
  useSettingsDesktop: () => dependencies.desktop,
  useSettingsJobEvents: () => dependencies.events,
}));
vi.mock("../../../../../../app/NotificationsProvider", () => ({
  useNotify: () => dependencies.notify,
}));
vi.mock("../../../../../../i18n/useText", () => ({
  useText: () => (key: string) => key,
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  dependencies.backend = makeBackend();
  dependencies.desktop = makeDesktop();
  dependencies.events = { next: vi.fn() };
  dependencies.notify.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AI settings consistency", () => {
  it("does not hide models or the folder when diagnostics fails", async () => {
    dependencies.backend.listModels.mockResolvedValue([{ id: "model" }]);
    dependencies.backend.diagnostics.mockRejectedValue(
      new Error("diagnostics unavailable"),
    );
    const { result } = renderHook(useAiSettings);
    await waitFor(() => expect(result.current.dataRoot).toBe("D:/data"));
    expect(result.current.models).toEqual([{ id: "model" }]);
    expect(result.current.free).toBeNull();
    expect(result.current.error).toBe("diagnostics unavailable");
  });

  it("rejects an old backend read after a successful change", async () => {
    const old = deferred<{ processingBackend: string }>();
    dependencies.backend.getAiProcessingSettings.mockReturnValueOnce(
      old.promise,
    );
    const { result } = renderHook(useAiSettings);
    await waitFor(() => expect(result.current.models).toEqual([]));
    await act(async () => {
      await result.current.changeBackend("Kaggle");
    });
    expect(
      dependencies.backend.updateAiProcessingSettings,
    ).toHaveBeenCalledWith({
      processingBackend: "Kaggle",
    });
    expect(result.current.backend).toBe("Kaggle");
    await act(async () => {
      old.resolve({ processingBackend: "Local" });
    });
    expect(result.current.backend).toBe("Kaggle");
  });

  it("reloads the authoritative backend when a failed write invalidated its initial read", async () => {
    const old = deferred<{ processingBackend: string }>();
    dependencies.backend.getAiProcessingSettings
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ processingBackend: "Kaggle" });
    dependencies.backend.updateAiProcessingSettings.mockRejectedValueOnce(
      new Error("Write failed"),
    );
    const { result } = renderHook(useAiSettings);
    await waitFor(() => expect(result.current.models).toEqual([]));
    await act(async () => {
      await result.current.changeBackend("Local");
    });
    await waitFor(() => expect(result.current.backend).toBe("Kaggle"));
    await act(async () => {
      old.resolve({ processingBackend: "Local" });
    });
    expect(result.current.backend).toBe("Kaggle");
    expect(dependencies.backend.getAiProcessingSettings).toHaveBeenCalledTimes(
      2,
    );
    expect(dependencies.notify).toHaveBeenCalledWith("Write failed", "error");
  });

  it("rejects an old folder read after the selected folder was saved", async () => {
    const old = deferred<string>();
    dependencies.desktop.getStorageRoot.mockReturnValueOnce(old.promise);
    const { result } = renderHook(useAiSettings);
    await waitFor(() => expect(result.current.models).toEqual([]));
    await act(async () => {
      await result.current.chooseDataRoot();
    });
    expect(dependencies.desktop.setStorageRoot).toHaveBeenCalledWith("E:/data");
    expect(result.current.dataRoot).toBe("E:/data");
    await act(async () => {
      old.resolve("D:/old");
    });
    expect(result.current.dataRoot).toBe("E:/data");
  });

  it("keeps the saved data folder when persisting a new one fails", async () => {
    dependencies.desktop.setStorageRoot.mockRejectedValueOnce(
      new Error("Storage unavailable"),
    );
    const { result } = renderHook(useAiSettings);
    await waitFor(() => expect(result.current.dataRoot).toBe("D:/data"));
    await act(async () => {
      await result.current.chooseDataRoot();
    });
    expect(dependencies.desktop.setStorageRoot).toHaveBeenCalledWith("E:/data");
    expect(result.current.dataRoot).toBe("D:/data");
  });

  it("loads the current folder when the picker is cancelled during initial loading", async () => {
    const old = deferred<string>();
    dependencies.desktop.getStorageRoot.mockReturnValueOnce(old.promise);
    dependencies.desktop.pickStorageFolder.mockResolvedValue(null);
    const { result } = renderHook(useAiSettings);
    await waitFor(() => expect(result.current.models).toEqual([]));
    await act(async () => {
      await result.current.chooseDataRoot();
    });
    await act(async () => {
      old.resolve("D:/stale");
    });
    expect(result.current.dataRoot).toBe("D:/data");
    expect(dependencies.desktop.getStorageRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.desktop.setStorageRoot).not.toHaveBeenCalled();
  });

  it("reports a cancellation failure", async () => {
    dependencies.backend.cancelJob.mockRejectedValue(
      new Error("cannot cancel"),
    );
    const { result } = renderHook(useAiSettings);
    await act(async () => {
      await result.current.cancel("job");
    });
    expect(dependencies.notify).toHaveBeenCalledWith("cannot cancel", "error");
  });

  it("keeps a save locked across tab remount and refreshes the reopened tab on completion", async () => {
    const save = deferred<{ processingBackend: string }>();
    dependencies.backend.updateAiProcessingSettings.mockReturnValueOnce(
      save.promise,
    );
    const first = renderHook(useAiSettings);
    await waitFor(() => expect(first.result.current.models).toEqual([]));
    let completion!: Promise<void>;
    act(() => {
      completion = first.result.current.changeBackend("Kaggle");
    });
    first.unmount();
    const reopened = renderHook(useAiSettings);
    expect(reopened.result.current.savingBackend).toBe(true);
    await act(async () => {
      await reopened.result.current.changeBackend("Local");
    });
    expect(
      dependencies.backend.updateAiProcessingSettings,
    ).toHaveBeenCalledOnce();
    dependencies.backend.getAiProcessingSettings.mockResolvedValue({
      processingBackend: "Kaggle",
    });
    await act(async () => {
      save.resolve({ processingBackend: "Kaggle" });
      await completion;
    });
    await waitFor(() => expect(reopened.result.current.backend).toBe("Kaggle"));
    expect(reopened.result.current.savingBackend).toBe(false);
  });

  it("does not apply another instance's stale read while a shared save is pending", async () => {
    dependencies.backend.getAiProcessingSettings.mockResolvedValue({
      processingBackend: "Kaggle",
    });
    const first = renderHook(useAiSettings);
    const second = renderHook(useAiSettings);
    await waitFor(() => expect(second.result.current.backend).toBe("Kaggle"));
    const old = deferred<{ processingBackend: string }>();
    const save = deferred<{ processingBackend: string }>();
    dependencies.backend.getAiProcessingSettings.mockReturnValueOnce(
      old.promise,
    );
    dependencies.backend.updateAiProcessingSettings.mockReturnValueOnce(
      save.promise,
    );
    let refresh!: Promise<void>;
    let completion!: Promise<void>;
    act(() => {
      refresh = second.result.current.refresh();
    });
    act(() => {
      completion = first.result.current.changeBackend("Local");
    });
    await act(async () => {
      old.resolve({ processingBackend: "Local" });
      await refresh;
    });
    expect(second.result.current.backend).toBe("Kaggle");
    dependencies.backend.getAiProcessingSettings.mockResolvedValue({
      processingBackend: "Local",
    });
    await act(async () => {
      save.resolve({ processingBackend: "Local" });
      await completion;
    });
    await waitFor(() => expect(second.result.current.backend).toBe("Local"));
  });

  it("refreshes untracked downloads while visible and stops after completion", async () => {
    vi.useFakeTimers();
    dependencies.backend.listModels
      .mockResolvedValueOnce([{ id: "model", state: "downloading" }])
      .mockResolvedValue([{ id: "model", state: "ready" }]);
    const { result } = renderHook(useAiSettings);
    await act(async () => {});
    expect(result.current.models?.[0]?.state).toBe("downloading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.models?.[0]?.state).toBe("ready");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(dependencies.backend.listModels).toHaveBeenCalledTimes(2);
  });

  it("stops refreshing untracked downloads when the last view closes", async () => {
    vi.useFakeTimers();
    dependencies.backend.listModels.mockResolvedValue([
      { id: "model", state: "downloading" },
    ]);
    const view = renderHook(useAiSettings);
    await act(async () => {});
    expect(view.result.current.models?.[0]?.state).toBe("downloading");
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(dependencies.backend.listModels).toHaveBeenCalledTimes(1);
  });
});
