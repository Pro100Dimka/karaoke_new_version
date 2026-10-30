import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useStorageCleanup } from "./useStorageCleanup";

const { backend, ask, notify } = vi.hoisted(() => ({
  backend: { clearCache: vi.fn(), clearTemporaryFiles: vi.fn() },
  ask: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("../../../../../../services/pythonClient", () => ({
  pythonClient: backend,
}));
vi.mock("../../../../../../providers/dialog", () => ({
  ask: ask,
}));
vi.mock("../../../../../../providers/notifications", () => ({
  useNotify: () => notify,
}));


beforeEach(() => {
  vi.resetAllMocks();
  ask.mockResolvedValue("confirm");
  backend.clearCache.mockResolvedValue(undefined);
  backend.clearTemporaryFiles.mockResolvedValue(undefined);
});

it.each([
  ["cache", "clearCache", "clearTemporaryFiles"],
  ["temp", "clearTemporaryFiles", "clearCache"],
] as const)(
  "cleans only the confirmed %s and refreshes usage",
  async (kind, method, other) => {
    const onChanged = vi.fn();
    const { result } = renderHook(() => useStorageCleanup(onChanged));
    await act(async () => result.current.clean(kind));

    expect(backend[method]).toHaveBeenCalledOnce();
    expect(backend[other]).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("Очистка выполнена", "success");
    expect(result.current.cleaning).toBeNull();
  },
);

it("does not modify storage when confirmation is cancelled", async () => {
  ask.mockResolvedValue("cancel");
  const onChanged = vi.fn();
  const { result } = renderHook(() => useStorageCleanup(onChanged));
  await act(async () => result.current.clean("cache"));

  expect(backend.clearCache).not.toHaveBeenCalled();
  expect(backend.clearTemporaryFiles).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(result.current.cleaning).toBeNull();
});

it("holds the lock through confirmation and the backend operation", async () => {
  let confirm!: (choice: string) => void;
  let finish!: () => void;
  ask.mockReturnValue(
    new Promise<string>((resolve) => {
      confirm = resolve;
    }),
  );
  backend.clearCache.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const onChanged = vi.fn();
  const { result } = renderHook(() => useStorageCleanup(onChanged));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.clean("cache");
  });
  await act(async () => result.current.clean("temp"));
  expect(ask).toHaveBeenCalledOnce();
  expect(result.current.cleaning).toBe("cache");

  await act(async () => confirm("confirm"));
  await act(async () => result.current.clean("temp"));
  expect(ask).toHaveBeenCalledOnce();
  expect(backend.clearCache).toHaveBeenCalledOnce();
  expect(backend.clearTemporaryFiles).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();

  await act(async () => {
    finish();
    await pending;
  });
  expect(result.current.cleaning).toBeNull();
  expect(onChanged).toHaveBeenCalledOnce();
});

it.each(["confirmation", "backend"] as const)(
  "releases the lock and reports a failed %s",
  async (stage) => {
    const failed = stage === "confirmation" ? ask : backend.clearCache;
    failed.mockRejectedValueOnce(new Error("failed"));
    const onChanged = vi.fn();
    const { result } = renderHook(() => useStorageCleanup(onChanged));
    await act(async () => result.current.clean("cache"));

    expect(notify).toHaveBeenCalledWith("Не удалось выполнить очистку", "error");
    expect(onChanged).not.toHaveBeenCalled();
    expect(result.current.cleaning).toBeNull();
    await act(async () => result.current.clean("cache"));
    expect(onChanged).toHaveBeenCalledOnce();
  },
);
