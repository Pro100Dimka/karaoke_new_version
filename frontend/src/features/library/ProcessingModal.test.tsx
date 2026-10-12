import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pythonClient } from "../../services/pythonClient";
import { ProcessingModal } from "./ProcessingModal";
import { LibraryProvider } from "../../app/LibraryProvider";
import type { ProcessingJobDto } from "../../contracts/models";
import { useProcessingQueue } from "./useProcessingQueue";

vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktop");
});

it.each(["reply", "failure"])("keeps a pushed completed job when the older request finishes with %s", async (outcome) => {
  vi.useFakeTimers();
  let pushed: (event: unknown) => void = () => undefined;
  Object.assign(window, { desktop: { onBackendEvent: (listener: typeof pushed) => {
    pushed = listener;
    return vi.fn();
  } } });
  const completed: ProcessingJobDto = {
    id: "job", songId: "song", type: "ProcessSong", state: "completed", stage: "Completed", progress: 100,
  };
  let finish!: (value: ProcessingJobDto[]) => void;
  let fail!: (error: Error) => void;
  vi.spyOn(pythonClient, "listJobs").mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  })).mockResolvedValue([completed]);
  const { result } = renderHook(() => useProcessingQueue(true), { wrapper: LibraryProvider });
  await act(async () => {
    pushed({ type: "job.changed", data: { jobId: completed.id } });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.ordered).toEqual([completed]);
  await act(async () => {
    if (outcome === "reply") finish([{ ...completed, state: "processing", progress: 25 }]);
    else fail(new Error("obsolete request disconnected"));
  });
  expect(result.current.ordered).toEqual([completed]);
  expect(result.current.failed).toBe(false);
});

it("keeps only one queue request in flight and stops polling when closed", async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const pending = new Promise<[]>((resolve) => {
    finish = () => resolve([]);
  });
  const load = vi
    .spyOn(pythonClient, "listJobs")
    .mockReturnValueOnce(pending)
    .mockResolvedValue([]);
  const props = {
    songs: [],
    onClose: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onOpenFolder: vi.fn(),
    onPlay: vi.fn(),
  };
  const view = render(<LibraryProvider><ProcessingModal {...props} open /></LibraryProvider>);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish?.();
    await pending;
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(load).toHaveBeenCalledTimes(2);
  view.rerender(<LibraryProvider><ProcessingModal {...props} open={false} /></LibraryProvider>);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(load).toHaveBeenCalledTimes(2);
});
