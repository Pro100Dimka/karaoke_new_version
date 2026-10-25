import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pythonClient } from "../../services/pythonClient";
import { ProcessingModal } from "./ProcessingModal";
import { LibraryProvider } from "../../app/LibraryProvider";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import { desktopClient } from "../../services/desktopClient";
import { useProcessingQueue } from "./useProcessingQueue";
import { ProcessingSignal } from "./ProcessingSignal";
import { ProcessingJobCard, type JobActions } from "./ProcessingJobCard";
import { clearStorage } from "../../shared/storage/localStore";

vi.mock("../../i18n/useText", () => ({ useText: () => (key: string) => key }));

afterEach(() => {
  cleanup();
  clearStorage();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktop");
});

it("shows free disk space and application size without inventing disk capacity", async () => {
  vi.spyOn(pythonClient, "listJobs").mockResolvedValue([]);
  vi.spyOn(pythonClient, "diagnostics").mockResolvedValue({
    storage: {
      free: 1000,
      songs: 100,
      models: 200,
      cache: 0,
      recordings: 0,
      temp: 0,
    },
  } as Awaited<ReturnType<typeof pythonClient.diagnostics>>);
  render(
    <LibraryProvider>
      <ProcessingModal
        open
        songs={[]}
        onClose={vi.fn()}
        onCancel={vi.fn()}
        onOpenFolder={vi.fn()}
        onPlay={vi.fn()}
      />
    </LibraryProvider>,
  );
  await waitFor(() =>
    expect(screen.getByText(/processingDiskUsage/)).toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("progressbar", { name: "processingDiskFree" }),
  ).not.toBeInTheDocument();
});

it.each(["failed", "cancelled"] as const)(
  "keeps a human title and understandable %s state after deleting the song",
  (state) => {
    const job = {
      id: "job",
      songId: "raw-uuid",
      songTitle: "Saved title",
      songArtist: "Saved artist",
      type: "SongProcessing",
      state,
      stage: "Failed",
      progress: 5,
      error: {
        code: "BackgroundFailure",
        message: "Background job failed",
        source: "python",
      },
    } as ProcessingJobDto;
    const { container } = render(
      <ProcessingJobCard job={job} index={0} actions={{} as JobActions} />,
    );
    expect(screen.getByText("Saved artist — Saved title")).toBeInTheDocument();
    expect(screen.queryByText("Background job failed")).not.toBeInTheDocument();
    if (state === "cancelled")
      expect(
        container.querySelector('.ad-status-indicator[data-status="error"]'),
      ).toBeNull();
    else expect(screen.getByText("processingFailedHelp")).toBeInTheDocument();
  },
);

it("keeps cleared jobs hidden after reopening and fresh backend results, while showing new jobs", async () => {
  const jobs: ProcessingJobDto[] = [
    "completed",
    "failed",
    "interrupted",
    "processing",
  ].map((state, index) => ({
    id: `old-${index}`,
    songId: "song",
    type: "SongProcessing",
    state: state as ProcessingJobDto["state"],
    stage: "MusicAnalysis",
    progress: 22,
  }));
  const list = vi.spyOn(pythonClient, "listJobs").mockResolvedValue(jobs);
  const first = renderHook(() => useProcessingQueue(true), {
    wrapper: LibraryProvider,
  });
  await waitFor(() => expect(first.result.current.visible).toHaveLength(4));
  act(() => first.result.current.hide(jobs.map((job) => job.id)));
  await waitFor(() => expect(first.result.current.visible).toHaveLength(0));
  first.unmount();

  const fresh = {
    ...jobs[0]!,
    id: "new-processing",
    state: "processing" as const,
  };
  list.mockResolvedValue([
    ...jobs.map((job) => ({ ...job, state: "completed" as const })),
    fresh,
  ]);
  const reopened = renderHook(() => useProcessingQueue(true), {
    wrapper: LibraryProvider,
  });
  await waitFor(() => expect(reopened.result.current.ordered).toEqual([fresh]));
});

it("keeps the library waveform accessible without the stage and percentage caption", () => {
  render(<ProcessingSignal progress={22} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "22",
  );
  expect(screen.queryByText("22%")).not.toBeInTheDocument();
});

it("loads the song waveform for processing instead of drawing the progress component's sample wave", async () => {
  const peaks = vi
    .spyOn(desktopClient, "waveformPeaks")
    .mockResolvedValue([0, 0.8, 0.2, 1]);
  const { container } = render(
    <ProcessingSignal
      progress={22}
      song={{ id: "song", activeRevision: 7 } as SongDto}
    />,
  );
  await waitFor(() => expect(peaks).toHaveBeenCalledWith("song", 7, 480));
  expect(container.querySelector(".ad-waveform")).not.toBeNull();
  expect(container.querySelector(".ad-progress-wave-idle")).toBeNull();
});

it.each(["reply", "failure"])(
  "keeps a pushed completed job when the older request finishes with %s",
  async (outcome) => {
    vi.useFakeTimers();
    let pushed: (event: unknown) => void = () => undefined;
    Object.assign(window, {
      desktop: {
        onBackendEvent: (listener: typeof pushed) => {
          pushed = listener;
          return vi.fn();
        },
      },
    });
    const completed: ProcessingJobDto = {
      id: "job",
      songId: "song",
      type: "ProcessSong",
      state: "completed",
      stage: "Completed",
      progress: 100,
    };
    let finish!: (value: ProcessingJobDto[]) => void;
    let fail!: (error: Error) => void;
    vi.spyOn(pythonClient, "listJobs")
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      )
      .mockResolvedValue([completed]);
    const { result } = renderHook(() => useProcessingQueue(true), {
      wrapper: LibraryProvider,
    });
    await act(async () => {
      pushed({ type: "job.changed", data: { jobId: completed.id } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.ordered).toEqual([completed]);
    await act(async () => {
      if (outcome === "reply")
        finish([{ ...completed, state: "processing", progress: 25 }]);
      else fail(new Error("obsolete request disconnected"));
    });
    expect(result.current.ordered).toEqual([completed]);
    expect(result.current.failed).toBe(false);
  },
);

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
    onOpenFolder: vi.fn(),
    onPlay: vi.fn(),
  };
  const view = render(
    <LibraryProvider>
      <ProcessingModal {...props} open />
    </LibraryProvider>,
  );
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
  view.rerender(
    <LibraryProvider>
      <ProcessingModal {...props} open={false} />
    </LibraryProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(load).toHaveBeenCalledTimes(2);
});
