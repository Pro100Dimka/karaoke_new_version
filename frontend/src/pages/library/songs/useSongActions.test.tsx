import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SongDto } from "../../../contracts/models";
import { useSongActions } from "./useSongActions";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  notify: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../../../providers/dialog", () => ({ ask: mocks.ask }));
vi.mock("../../../providers/notifications", () => ({
  useNotify: () => mocks.notify,
}));
vi.mock("../../../pages/editor/editorApi", () => ({
  editorApi: { reset: mocks.reset },
}));
vi.mock("../../../services/pythonClient", () => ({ pythonClient: {} }));


const song: SongDto = {
  id: "song",
  title: "Song",
  artist: "Artist",
  status: "ready",
  language: "Auto",
  durationSeconds: 200,
  activeRevision: 7,
  projectFormatVersion: 2,
  createdAt: "2026-10-20",
  coverState: "Fallback",
};

describe("confirmed baseline reset and lyric reprocessing", () => {
  it.each([
    "ready",
    "failed",
    "invalid",
    "queued",
    "processing",
    "importing",
  ] as const)(
    "does not start processing an existing %s song",
    async (status) => {
      const processSong = vi.fn();
      const { result } = renderHook(() =>
        useSongActions(
          { processSong, refresh: vi.fn(), deleteSong: vi.fn() },
          vi.fn(),
        ),
      );
      await act(() => result.current.startProcessing({ ...song, status }));
      expect(processSong).not.toHaveBeenCalled();
    },
  );

  it("starts processing only for a newly added song", async () => {
    const processSong = vi.fn();
    const { result } = renderHook(() =>
      useSongActions(
        { processSong, refresh: vi.fn(), deleteSong: vi.fn() },
        vi.fn(),
      ),
    );
    const added = { ...song, status: "not-processed" as const };
    await act(() => result.current.startProcessing(added));
    expect(processSong).toHaveBeenCalledExactlyOnceWith(added);
  });
  beforeEach(() => vi.resetAllMocks());

  it("does not reset or reprocess when the preservation confirmation is cancelled", async () => {
    mocks.ask.mockResolvedValue("cancel");
    const processSong = vi.fn();
    const { result } = renderHook(() =>
      useSongActions(
        { processSong, refresh: vi.fn(), deleteSong: vi.fn() },
        vi.fn(),
      ),
    );
    await act(() => result.current.resetAndReprocess(song));
    expect(mocks.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Ваши правки в ревизии 7 останутся в истории проекта. Приложение создаст новую ревизию из AI-разметки, затем заново выровняет слова и ноты по вокалу.",
      }),
    );
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(processSong).not.toHaveBeenCalled();
  });

  it("preserves the confirmed manual revision before starting a new lyrics job", async () => {
    mocks.ask.mockResolvedValue("reset");
    let finish!: (revision: number) => void;
    mocks.reset.mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const processSong = vi.fn();
    const { result } = renderHook(() =>
      useSongActions(
        { processSong, refresh: vi.fn(), deleteSong: vi.fn() },
        vi.fn(),
      ),
    );
    let resetting!: Promise<void>;
    await act(async () => {
      resetting = result.current.resetAndReprocess(song);
    });
    expect(mocks.reset).toHaveBeenCalledExactlyOnceWith("song", 7);
    expect(processSong).not.toHaveBeenCalled();
    await act(async () => {
      finish(8);
      await resetting;
    });
    expect(processSong).toHaveBeenCalledExactlyOnceWith(
      { ...song, activeRevision: 8 },
      "lyrics",
    );
    expect(mocks.notify).toHaveBeenLastCalledWith("Обработка запущена", "info");
  });

  it("keeps the current project and never starts processing when reset conflicts", async () => {
    mocks.ask.mockResolvedValue("reset");
    mocks.reset.mockRejectedValue({
      code: "RevisionConflict",
      message: "Changed",
      source: "python",
    });
    const processSong = vi.fn();
    const { result } = renderHook(() =>
      useSongActions(
        { processSong, refresh: vi.fn(), deleteSong: vi.fn() },
        vi.fn(),
      ),
    );
    await act(() => result.current.resetAndReprocess(song));
    expect(processSong).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenLastCalledWith(
      "Проект изменился после открытия.",
      "error",
    );
  });

  it("refreshes the restored revision even when the following job cannot start", async () => {
    mocks.ask.mockResolvedValue("reset");
    mocks.reset.mockResolvedValue(8);
    let displayedRevision = 7;
    const refresh = vi.fn(async () => {
      displayedRevision = 8;
    });
    const processSong = vi.fn().mockRejectedValue({
      code: "MissingRequiredModels",
      message: "Models unavailable",
      source: "python",
    });
    const { result } = renderHook(() =>
      useSongActions({ processSong, refresh, deleteSong: vi.fn() }, vi.fn()),
    );
    await act(() => result.current.resetAndReprocess(song));
    expect(displayedRevision).toBe(8);
    expect(processSong).toHaveBeenCalledExactlyOnceWith(
      { ...song, activeRevision: 8 },
      "lyrics",
    );
    expect(mocks.notify).toHaveBeenLastCalledWith(
      "Не хватает AI-моделей. Скачайте их в Настройки → AI / Обработка.",
      "error",
    );
  });
});
