import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { clearStorage } from "../../shared/storage/localStore";
import { EditorProvider } from "../../app/EditorProvider";
import { useEditorSession } from "./useEditorSession";

const dialogs = vi.hoisted(() => ({
  ask: vi.fn(),
  notify: vi.fn(),
  text: (key: string) => key,
}));

vi.mock("../../app/DialogProvider", () => ({ useAsk: () => dialogs.ask }));
vi.mock("../../app/CloseGuards", () => ({ useCloseGuard: vi.fn() }));
vi.mock("../../app/NotificationsProvider", () => ({ useNotify: () => dialogs.notify }));
vi.mock("../../i18n/useText", () => ({ useText: () => dialogs.text }));
vi.mock("../../services/pythonClient", () => ({
  pythonClient: { getSong: vi.fn(), projectCompatibility: vi.fn() },
}));
vi.mock("../../services/audioClient", () => ({
  audioClient: {
    prepareSong: vi.fn(),
    stop: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
  },
  getAudioSnapshot: vi.fn(),
}));
const editorApi = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("./editorApi", () => ({ createEditorApi: () => editorApi }));

describe("editor session audio preparation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearStorage();
    vi.mocked(pythonClient.getSong).mockImplementation(async (id) =>
      ({ id, status: "ready", activeRevision: 1 }) as never,
    );
    vi.mocked(pythonClient.projectCompatibility).mockResolvedValue("Current");
    vi.mocked(editorApi.load).mockResolvedValue({
      revision: 1,
      words: [],
      notes: [],
    });
    vi.mocked(audioClient.stop).mockResolvedValue({} as never);
    vi.mocked(audioClient.play).mockResolvedValue({} as never);
  });

  it("disables playback while preparing a different song in the same session", async () => {
    let finishSecondPreparation!: () => void;
    vi.mocked(audioClient.prepareSong)
      .mockResolvedValueOnce({} as never)
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          finishSecondPreparation = () => resolve({} as never);
        }),
      );

    const { result, rerender } = renderHook(
      ({ songId }) => useEditorSession(songId),
      { initialProps: { songId: "first" }, wrapper: EditorProvider },
    );
    await waitFor(() => expect(result.current.audioReady).toBe(true));

    rerender({ songId: "second" });
    await waitFor(() => expect(audioClient.prepareSong).toHaveBeenCalledTimes(2));
    expect(result.current.audioReady).toBe(false);
    await act(async () => result.current.togglePlay());
    expect(audioClient.play).not.toHaveBeenCalled();

    await act(async () => finishSecondPreparation());
    expect(result.current.audioReady).toBe(true);
  });
});
