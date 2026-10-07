import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pythonClient } from "../../services/pythonClient";
import { ProcessingModal } from "./ProcessingModal";
import { LibraryProvider } from "../../app/LibraryProvider";

vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
