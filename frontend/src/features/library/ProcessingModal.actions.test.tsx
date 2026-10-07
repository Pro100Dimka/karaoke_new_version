import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import { pythonClient } from "../../services/pythonClient";
import { ProcessingModal } from "./ProcessingModal";
import { LibraryProvider } from "../../app/LibraryProvider";

vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const song = (id: string, title: string): SongDto => ({
  id,
  title,
  artist: "Artist",
  language: "Auto",
  status: "ready",
  durationSeconds: 60,
  createdAt: "2026-10-01T00:00:00Z",
  coverState: "Fallback",
  activeRevision: 1,
  projectFormatVersion: 2,
});

const job = (
  id: string,
  songId: string,
  state: ProcessingJobDto["state"],
): ProcessingJobDto => ({
  id,
  songId,
  type: "SongProcessing",
  state,
  stage: "ProjectValidationPublication",
  progress: state === "completed" ? 100 : 0,
});

it("connects every processing queue control to an action", async () => {
  const songs = [
    song("done", "Done song"),
    song("queued-a", "Queued A"),
    song("queued-b", "Queued B"),
    song("failed", "Failed song"),
    song("active", "Active song"),
  ];
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([
    job("job-done", "done", "completed"),
    job("job-queued-a", "queued-a", "queued"),
    job("job-queued-b", "queued-b", "queued"),
    job("job-failed", "failed", "failed"),
    job("job-active", "active", "processing"),
  ]);
  const onOpenFolder = vi.fn();
  const onPlay = vi.fn();
  const onCancel = vi.fn().mockResolvedValue(undefined);
  const onRetry = vi.fn().mockResolvedValue(undefined);

  render(
    <LibraryProvider>
    <ProcessingModal
      open
      songs={songs}
      onClose={vi.fn()}
      onCancel={onCancel}
      onRetry={onRetry}
      onOpenFolder={onOpenFolder}
      onPlay={onPlay}
    />,
    </LibraryProvider>
  );

  const doneCard = (await screen.findByText("Artist — Done song")).closest(
    "li",
  )!;
  fireEvent.click(within(doneCard).getByRole("button", { name: "openFolder" }));
  fireEvent.click(within(doneCard).getByRole("button", { name: "play" }));
  expect(onOpenFolder).toHaveBeenCalledWith(songs[0]);
  expect(onPlay).toHaveBeenCalledWith(songs[0]);

  const activeCard = screen.getByText("Artist — Active song").closest("li")!;
  fireEvent.click(within(activeCard).getByRole("button", { name: "cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "processingStop" }));
  expect(onCancel).toHaveBeenCalledWith("job-active");

  const failedCard = screen.getByText("Artist — Failed song").closest("li")!;
  fireEvent.click(within(failedCard).getByRole("button", { name: "retry" }));
  expect(onRetry).toHaveBeenCalledWith(songs[3]);

  const queuedBCard = screen.getByText("Artist — Queued B").closest("li")!;
  fireEvent.click(
    within(queuedBCard).getByRole("button", { name: "processingMoveUp" }),
  );
  const titles = screen
    .getAllByRole("listitem")
    .map((item) => item.querySelector("strong")?.textContent);
  expect(titles.indexOf("Artist — Queued B")).toBeLessThan(
    titles.indexOf("Artist — Queued A"),
  );

  fireEvent.click(
    within(doneCard).getByRole("button", { name: "processingJobActions" }),
  );
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: "processingJobDetails" }),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "processingDiskInfo" }));
  expect(
    screen.getByRole("dialog", { name: "processingDiskTitle" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "done" }));

  fireEvent.click(
    screen.getByRole("button", { name: "processingClearCompleted" }),
  );
  expect(
    screen.getByRole("dialog", { name: "processingClearCompletedTitle" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "processingClear" }));
  await waitFor(() =>
    expect(screen.queryByText("Artist — Done song")).not.toBeInTheDocument(),
  );
});
