import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pythonClient } from "../../services/pythonClient";
import { ProcessingModal } from "./ProcessingModal";

vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps only one queue request in flight and stops polling when closed", async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const pending = new Promise<[]>(resolve => { finish = () => resolve([]); });
  const load = vi.spyOn(pythonClient, "listJobs").mockReturnValueOnce(pending).mockResolvedValue([]);
  const props = { songs: [], onClose: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn() };
  const view = render(<ProcessingModal {...props} open />);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => { finish?.(); await pending; });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(load).toHaveBeenCalledTimes(2);
  view.rerender(<ProcessingModal {...props} open={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(load).toHaveBeenCalledTimes(2);
});

it("shows how long a completed song took to process", async () => {
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([{
    id: "job-1",
    type: "SongProcessing",
    songId: "song-1",
    state: "completed",
    stage: "Completed",
    progress: 100,
    startedAt: "2026-09-25T12:00:00Z",
    finishedAt: "2026-09-25T12:03:17Z"
  }]);

  render(
    <ProcessingModal
      open
      songs={[]}
      onClose={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />
  );

  expect(await screen.findByText("processingDuration: 3:17")).toBeInTheDocument();
});
