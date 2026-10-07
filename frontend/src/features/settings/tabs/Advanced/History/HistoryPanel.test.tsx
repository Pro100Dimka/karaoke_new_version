import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { HistoryEventDto } from "../../../../../contracts/models";
import { pythonClient } from "../../../../../services/pythonClient";
import { HistoryPanel } from ".";

vi.mock("../../../../../i18n/useText", () => ({
  useText: () => (key: string) => key,
}));

vi.mock("../../../../../services/pythonClient", () => ({
  pythonClient: {
    history: vi.fn(),
    listSongs: vi.fn(),
  },
}));

beforeEach(() => vi.clearAllMocks());

it("ignores a failed history request after switching tabs", async () => {
  let rejectPrevious!: (error: Error) => void;
  vi.mocked(pythonClient.history)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrevious = reject;
        }),
    )
    .mockResolvedValueOnce({
      items: [
        {
          id: "processing-event",
          kind: "ProcessingFailed",
          createdAt: "2026-01-01T00:00:00Z",
        } satisfies HistoryEventDto,
      ],
      total: 1,
    });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([]);

  render(<HistoryPanel />);
  fireEvent.click(screen.getByText("historyProcessing"));
  expect(await screen.findByText("historyKindProcessingFailed")).toBeVisible();

  await act(async () => rejectPrevious(new Error("Old tab failed")));
  expect(pythonClient.history).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("historyLoadFailed")).not.toBeInTheDocument();
});

it("ignores the first request after returning to the same history tab", async () => {
  let resolvePrevious!: (
    page: Awaited<ReturnType<typeof pythonClient.history>>,
  ) => void;
  vi.mocked(pythonClient.history)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrevious = resolve;
        }),
    )
    .mockResolvedValueOnce({ items: [], total: 0 })
    .mockResolvedValueOnce({
      items: [
        {
          id: "current-performance",
          kind: "RecordingRegistered",
          createdAt: "2026-01-02T00:00:00Z",
        },
      ],
      total: 1,
    });
  vi.mocked(pythonClient.listSongs).mockResolvedValue([]);

  render(<HistoryPanel />);
  fireEvent.click(screen.getByText("historyProcessing"));
  fireEvent.click(screen.getByText("historyPerformances"));
  expect(await screen.findByText("historyKindRecordingRegistered")).toBeVisible();

  await act(async () => {
    resolvePrevious({
      items: [
        {
          id: "stale-performance",
          kind: "AnalysisCompleted",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
    });
  });
  expect(screen.getByText("historyKindRecordingRegistered")).toBeVisible();
  expect(screen.queryByText("historyKindAnalysisCompleted")).not.toBeInTheDocument();
});
