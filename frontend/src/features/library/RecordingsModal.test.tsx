import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { RecordingDto, SongDto } from "../../contracts/models";
import { RecordingsModal } from "./RecordingsModal";

vi.mock("./RecordingPlayer", () => ({ RecordingPlayer: () => <div /> }));
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

const song: SongDto = {
  id: "song-1", title: "Небо", artist: "Artist", language: "Auto", status: "ready",
  durationSeconds: 60, createdAt: "2026-01-01T00:00:00Z", coverState: "Fallback",
  activeRevision: 1, projectFormatVersion: 1,
};

const recording = (id: string, sizeBytes: number): RecordingDto => ({
  id, sizeBytes, filePath: `${id}.wav`, songId: song.id, displayName: id,
  createdAt: "2026-01-01T00:00:00Z", durationSeconds: 30, analyzed: false,
} as RecordingDto);

describe("RecordingsModal total size", () => {
  it("shows the sum of recording file sizes instead of reference demo data", () => {
    render(<AppProvider><RecordingsModal song={song} recordings={[recording("one", 1024 ** 2), recording("two", 512 * 1024)]} onClose={vi.fn()} onAnalyze={vi.fn()} onDelete={vi.fn()} onRename={vi.fn()} /></AppProvider>);

    expect(screen.getByText("Общий размер: 1.5 MB")).toBeInTheDocument();
    expect(screen.queryByText("Общий размер: 48.7 MB")).not.toBeInTheDocument();
  });
});
