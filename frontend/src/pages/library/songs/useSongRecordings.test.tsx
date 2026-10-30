import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from "../../../contracts/models";
import type {
  RecordingAnalysisProgress,
  StudioMasterProgress,
} from "../../../contracts/clients";
import { useSongRecordings } from "./useSongRecordings";

const ports = vi.hoisted(() => ({
  listRecordings: vi.fn(),
  latestAnalysis: vi.fn(),
  analyzeRecording: vi.fn(),
  createStudioMaster: vi.fn(),
  notify: vi.fn(),
  ask: vi.fn(),
  locationState: null as Record<string, unknown> | null,
}));
vi.mock("../../../services/pythonClient", () => ({
  pythonClient: ports,
}));
vi.mock("../../../providers/notifications", () => ({
  useNotify: () => ports.notify,
}));
vi.mock("../../../providers/dialog", () => ({ ask: ports.ask }));

vi.mock("../../../providers/store", () => ({ store: { get playback() { return { returned: ports.locationState }; } } }));

const first = { id: "first", title: "First" } as SongDto;
const second = { id: "second", title: "Second" } as SongDto;
const take = (song: SongDto): RecordingDto => ({
  id: `take-${song.id}`,
  songId: song.id,
  filePath: `${song.id}.wav`,
  displayName: "",
  createdAt: "2026-10-12T00:00:00Z",
  durationSeconds: 10,
  sizeBytes: 100,
  analyzed: true,
});
const analysis = (song: SongDto): AnalysisDto => ({
  recordingId: take(song).id,
  score: 80,
  pitch: 80,
  rhythm: 80,
  stability: 80,
  summary: "",
});

describe("recording dialog ownership", () => {
  it("opens the returning performance analysis before its recordings finish loading", async () => {
    ports.locationState = {
      analysisSongId: first.id,
      analysisFor: take(first).id,
    };
    ports.listRecordings.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() =>
      useSongRecordings([first], true, vi.fn()),
    );
    await waitFor(() =>
      expect(result.current.analysisRecordId).toBe(take(first).id),
    );
    expect(result.current.analysisSong).toBe(first);
  });
  it("ignores old progress and completion when the same take has a newer request", async () => {
    const jobs: {
      progress: (value: RecordingAnalysisProgress) => void;
      finish: (value: AnalysisDto) => void;
    }[] = [];
    ports.analyzeRecording.mockImplementation(
      (_id, progress) =>
        new Promise((finish) => jobs.push({ progress, finish })),
    );
    const { result } = renderHook(() =>
      useSongRecordings([first], true, vi.fn()),
    );
    let older!: Promise<void>, newer!: Promise<void>;
    act(() => {
      older = result.current.analyze(take(first), true);
    });
    await waitFor(() => expect(jobs).toHaveLength(1));
    act(() => {
      newer = result.current.analyze(take(first), true);
    });
    await waitFor(() => expect(jobs).toHaveLength(2));
    const update = {
      recordingId: take(first).id,
      jobId: "new",
      state: "Running",
      stage: "Scoring",
      progress: 50,
    };
    act(() => jobs[1]!.progress(update));
    act(() => jobs[0]!.progress({ ...update, jobId: "old", progress: 99 }));
    expect(result.current.analysisProgress[take(first).id]?.jobId).toBe("new");
    await act(async () => {
      jobs[0]!.finish(analysis(first));
      await older;
    });
    expect(result.current.analysisProgress[take(first).id]?.jobId).toBe("new");
    await act(async () => {
      jobs[1]!.finish(analysis(first));
      await newer;
    });
  });
  it("does not report an intentionally cancelled analysis as a failure", async () => {
    ports.analyzeRecording.mockRejectedValue({
      code: "JobCancelled",
      message: "Cancelled",
      source: "python",
    });
    const { result } = renderHook(() =>
      useSongRecordings([first], true, vi.fn()),
    );
    await act(() => result.current.analyze(take(first), true));
    expect(result.current.analysisFailures[take(first).id]).toBeUndefined();
    expect(ports.notify).not.toHaveBeenCalled();
  });
  it("opens a stored result immediately without starting another analysis", async () => {
    ports.latestAnalysis.mockResolvedValue(analysis(first));
    const { result } = renderHook(() =>
      useSongRecordings([first], true, vi.fn()),
    );
    await act(() => result.current.analyze(take(first)));
    expect(result.current.analysis).toEqual(analysis(first));
    expect(ports.analyzeRecording).not.toHaveBeenCalled();
  });

  it("shows analysis progress, then refreshes the finished recording status", async () => {
    const updated = { ...take(first), analysisStatus: "Succeeded" as const };
    ports.listRecordings
      .mockResolvedValueOnce([take(first)])
      .mockResolvedValue([updated]);
    let finish!: (value: AnalysisDto) => void;
    let progress!: (value: {
      recordingId: string;
      jobId: string;
      state: string;
      stage: string;
      progress: number;
    }) => void;
    ports.analyzeRecording.mockImplementation((_id, callback) => {
      progress = callback;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const { result } = renderHook(() =>
      useSongRecordings([first], true, vi.fn()),
    );
    await act(() => result.current.open(first));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.analyze(take(first), true);
    });
    await waitFor(() => expect(ports.analyzeRecording).toHaveBeenCalled());
    act(() =>
      progress({
        recordingId: take(first).id,
        jobId: "job",
        state: "Running",
        stage: "PitchAnalysis",
        progress: 40,
      }),
    );
    expect(result.current.analysisProgress[take(first).id]?.progress).toBe(40);
    await act(async () => {
      finish(analysis(first));
      await pending;
    });
    expect(result.current.recordings).toEqual([updated]);
    expect(result.current.analysisProgress[take(first).id]).toBeUndefined();
  });

  it("explains insufficient pitch evidence after automatic post-performance analysis", async () => {
    ports.locationState = {
      analysisSongId: first.id,
      analysisFor: take(first).id,
    };
    ports.latestAnalysis.mockResolvedValue(null);
    ports.analyzeRecording.mockRejectedValue({
      code: "AnalysisPitchUncertain",
      message: "Not enough pitch",
      source: "python",
    });
    renderHook(() => useSongRecordings([first], true, vi.fn()));
    await waitFor(() =>
      expect(ports.notify).toHaveBeenCalledWith(
        "Недостаточно надёжных данных о высоте голоса. Проверьте качество записи и уровень микрофона.",
        "error",
      ),
    );
  });
  beforeEach(() => {
    vi.resetAllMocks();
    ports.locationState = null;
    ports.listRecordings.mockImplementation(async (id: string) => [
      take(id === first.id ? first : second),
    ]);
  });

  it.each([false, true])(
    "ignores an older song list after a newer dialog has opened (then closed: %s)",
    async (close) => {
      let finish!: (takes: RecordingDto[]) => void;
      ports.listRecordings.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const { result } = renderHook(() =>
        useSongRecordings([first, second], true, vi.fn()),
      );
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.open(first);
      });
      await act(() => result.current.open(second));
      if (close) act(() => result.current.close());
      await act(async () => {
        finish([take(first)]);
        await pending;
      });

      expect(result.current.song?.id ?? null).toBe(close ? null : second.id);
      expect(result.current.recordings).toEqual([take(second)]);
    },
  );

  it.each([false, true])(
    "ignores an older analysis after a newer analysis has opened (then closed: %s)",
    async (close) => {
      let finish!: (value: AnalysisDto) => void;
      ports.analyzeRecording
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue(analysis(second));
      const { result } = renderHook(() =>
        useSongRecordings([first, second], true, vi.fn()),
      );
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.analyze(take(first));
      });
      await waitFor(() =>
        expect(ports.analyzeRecording).toHaveBeenCalledOnce(),
      );
      await act(() => result.current.analyze(take(second)));
      if (close) act(() => result.current.closeAnalysis());
      await act(async () => {
        finish(analysis(first));
        await pending;
      });

      expect(result.current.analysis).toEqual(close ? null : analysis(second));
    },
  );

  it("does not insert a completed master into a different song's recordings", async () => {
    let finish!: (recording: RecordingDto) => void;
    ports.createStudioMaster.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useSongRecordings([first, second], true, vi.fn()),
    );
    await act(() => result.current.open(first));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.createStudioMaster(take(first));
    });
    act(() => result.current.close());
    await act(() => result.current.open(second));
    await act(async () => {
      finish({
        ...take(first),
        id: "master-first",
        sourceRecordingId: take(first).id,
      });
      await pending;
    });

    expect(result.current.song?.id).toBe(second.id);
    expect(result.current.recordings).toEqual([take(second)]);
  });

  it("ignores automatic post-performance analysis after the user selects another analysis", async () => {
    ports.locationState = {
      analysisSongId: first.id,
      analysisFor: take(first).id,
    };
    let finish!: (value: AnalysisDto | null) => void;
    ports.latestAnalysis
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(null);
    ports.analyzeRecording.mockResolvedValue(analysis(second));
    const { result } = renderHook(() =>
      useSongRecordings([first, second], true, vi.fn()),
    );
    await waitFor(() => expect(ports.latestAnalysis).toHaveBeenCalledOnce());
    await act(() => result.current.analyze(take(second)));
    await act(async () => {
      finish(analysis(first));
    });
    expect(result.current.analysis).toEqual(analysis(second));
  });

  it("opens the returned performance analysis through the StrictMode setup-cleanup cycle", async () => {
    ports.locationState = {
      analysisSongId: first.id,
      analysisFor: take(first).id,
    };
    ports.latestAnalysis.mockResolvedValue(analysis(first));
    const { result } = renderHook(
      () => useSongRecordings([first, second], true, vi.fn()),
      { wrapper: StrictMode },
    );
    await waitFor(() =>
      expect(result.current.analysis).toEqual(analysis(first)),
    );
    expect(ports.latestAnalysis).toHaveBeenCalledOnce();
  });

  it("does not continue automatic analysis after a different song's recordings were selected", async () => {
    ports.locationState = {
      analysisSongId: first.id,
      analysisFor: take(first).id,
    };
    let finish!: (value: RecordingDto[]) => void;
    ports.listRecordings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ports.latestAnalysis.mockResolvedValue(analysis(first));
    const { result } = renderHook(() =>
      useSongRecordings([first, second], true, vi.fn()),
    );
    await act(() => result.current.open(second));
    await act(async () => {
      finish([take(first)]);
    });
    expect(result.current.recordings).toEqual([take(second)]);
    expect(result.current.analysis).toBeNull();
    expect(ports.latestAnalysis).not.toHaveBeenCalled();
  });

  it("does not let an older mastering operation replace or clear the newer progress", async () => {
    const finish: Array<(recording: RecordingDto) => void> = [];
    const progress: Array<(value: StudioMasterProgress) => void> = [];
    ports.createStudioMaster.mockImplementation(
      (_id: string, onProgress: (value: StudioMasterProgress) => void) => {
        progress.push(onProgress);
        return new Promise((resolve) => {
          finish.push(resolve);
        });
      },
    );
    const { result } = renderHook(() =>
      useSongRecordings([first, second], true, vi.fn()),
    );
    await act(() => result.current.open(first));
    let older!: Promise<void>;
    act(() => {
      older = result.current.createStudioMaster(take(first));
    });
    await act(() => result.current.open(second));
    let newer!: Promise<void>;
    act(() => {
      newer = result.current.createStudioMaster(take(second));
    });
    act(() => {
      progress[1]?.({
        recordingId: take(second).id,
        stage: "Balancing",
        progress: 50,
      });
      progress[0]?.({
        recordingId: take(first).id,
        stage: "Balancing",
        progress: 80,
      });
    });
    expect(result.current.studioMaster?.recordingId).toBe(take(second).id);
    await act(async () => {
      finish[0]?.({ ...take(first), id: "master-first" });
      await older;
    });
    expect(result.current.studioMaster?.recordingId).toBe(take(second).id);
    await act(async () => {
      finish[1]?.({ ...take(second), id: "master-second" });
      await newer;
    });
    expect(result.current.studioMaster).toBeNull();
  });
});
