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
import { DialogProvider } from "../../app/DialogProvider";
import { useSongActions } from "./useSongActions";

const recovery = vi.hoisted(() => ({ reset: vi.fn(), notify: vi.fn() }));
vi.mock("../../app/EditorProvider", () => ({ useEditorRepository: () => ({ reset: recovery.reset }) }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => recovery.notify }));

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

it("offers explicit baseline recovery only for a manual-edit conflict", async () => {
  const existing = song("existing", "Edited song");
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([{
    ...job("manual-job", existing.id, "failed"), timingOperation: "lyrics",
    error: { code: "ManualLyricsConflict", message: "Manual edits exist", source: "python" },
  }]);
  const onResetLyrics = vi.fn();
  render(<LibraryProvider><ProcessingModal open songs={[existing]} onClose={vi.fn()}
    onCancel={vi.fn()} onRetry={vi.fn()} onResetLyrics={onResetLyrics}
    onOpenFolder={vi.fn()} onPlay={vi.fn()} />
  </LibraryProvider>);
  const card = (await screen.findByText("Artist — Edited song")).closest("li")!;
  fireEvent.click(within(card).getByRole("button", { name: "resetLyricsAndReprocess" }));
  expect(onResetLyrics).toHaveBeenCalledExactlyOnceWith(existing);
});

it.each(["cancel", "resetLyricsAndReprocess"])(
  "requires the rendered recovery confirmation before %s",
  async (choice) => {
    const existing = song("existing", "Edited song");
    vi.spyOn(pythonClient, "listJobs").mockResolvedValue([{
      ...job("manual-job", existing.id, "failed"), timingOperation: "lyrics",
      error: { code: "ManualLyricsConflict", message: "Manual edits exist", source: "python" },
    }]);
    recovery.reset.mockReset().mockResolvedValue(2);
    const processSong = vi.fn().mockResolvedValue(undefined);
    const operations = { processSong, refresh: vi.fn(), deleteSong: vi.fn() };
    const Harness = () => {
      const actions = useSongActions(operations, vi.fn());
      return <ProcessingModal open songs={[existing]} onClose={vi.fn()}
        onCancel={vi.fn()} onRetry={actions.startProcessing} onResetLyrics={actions.resetAndReprocess}
        onOpenFolder={vi.fn()} onPlay={vi.fn()} />;
    };
    render(<LibraryProvider><DialogProvider><Harness /></DialogProvider></LibraryProvider>);
    const card = (await screen.findByText("Artist — Edited song")).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "resetLyricsAndReprocess" }));
    const dialog = await screen.findByRole("dialog", { name: "resetLyricsTitle" });
    expect(within(dialog).getByText("resetLyricsBody")).toBeInTheDocument();
    expect(recovery.reset).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: choice }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "resetLyricsTitle" })).toBeNull());
    if (choice === "cancel") {
      expect(recovery.reset).not.toHaveBeenCalled();
      expect(processSong).not.toHaveBeenCalled();
    } else {
      expect(recovery.reset).toHaveBeenCalledExactlyOnceWith(existing.id, 1);
      expect(processSong).toHaveBeenCalledExactlyOnceWith({ ...existing, activeRevision: 2 }, "lyrics");
    }
  },
);

it("retries lyric realignment with the same operation instead of full source processing", async () => {
  const existing = song("existing", "Existing song");
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([{
    ...job("lyrics-job", existing.id, "failed"), timingOperation: "lyrics",
  }]);
  const onRetry = vi.fn().mockResolvedValue(undefined);
  render(<LibraryProvider><ProcessingModal open songs={[existing]} onClose={vi.fn()}
    onCancel={vi.fn()} onRetry={onRetry} onOpenFolder={vi.fn()} onPlay={vi.fn()} />
  </LibraryProvider>);
  const card = (await screen.findByText("Artist — Existing song")).closest("li")!;
  fireEvent.click(within(card).getByRole("button", { name: "retry" }));
  expect(onRetry).toHaveBeenCalledWith(existing, "lyrics");
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
  expect(onRetry).toHaveBeenCalledWith(songs[3], undefined);

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
