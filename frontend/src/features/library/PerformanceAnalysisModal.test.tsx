import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { AnalysisDto, RecordingDto } from "../../contracts/models";
import { PerformanceAnalysisModal } from "./PerformanceAnalysisModal";

vi.mock("./RecordingPlayer", () => ({
  RecordingPlayer: ({ recording }: { recording: RecordingDto }) => (
    <div>player:{recording.id}</div>
  ),
}));
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

const recording: RecordingDto = {
  id: "take-1",
  filePath: "take.wav",
  songId: "song-1",
  displayName: "",
  createdAt: "2026-01-01T00:00:00Z",
  durationSeconds: 180,
  sizeBytes: 0,
  analyzed: true,
};

const analysis: AnalysisDto = {
  recordingId: recording.id,
  score: 88,
  pitch: 90,
  rhythm: 84,
  stability: 89,
  summary: "",
};

describe("PerformanceAnalysisModal studio master", () => {
  it("identifies the song and the user's named take", () => {
    render(<AppProvider><PerformanceAnalysisModal analysis={analysis}
      recordings={[{ ...recording, displayName: "Концертный дубль" }]}
      song={{ title: "Километры", artist: "Wildways" } as import("../../contracts/models").SongDto}
      onDelete={vi.fn()} onClose={vi.fn()} onCreateStudioMaster={vi.fn()} studioMaster={null} /></AppProvider>);
    expect(screen.getByText("Wildways — Километры")).toBeInTheDocument();
    expect(screen.getByText("Концертный дубль")).toBeInTheDocument();
  });

  it("shows automatic analysis progress immediately and offers cancellation", () => {
    const cancel = vi.fn();
    render(<AppProvider><PerformanceAnalysisModal analysis={null} recordings={[recording]}
      pending={{ recordingId: recording.id, jobId: "job", state: "Queued", stage: "Queued", progress: 0 }}
      onCancelAnalysis={cancel} onDelete={vi.fn()} onClose={vi.fn()} onCreateStudioMaster={vi.fn()} studioMaster={null} /></AppProvider>);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Ожидает свободных ресурсов")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отменить анализ" }));
    expect(cancel).toHaveBeenCalledWith("job");
  });

  it("does not recommend correcting pitch when all measured metrics are perfect", () => {
    render(<AppProvider><PerformanceAnalysisModal
      analysis={{ ...analysis, score: 100, pitch: 100, rhythm: 100, stability: 100 }}
      recordings={[recording]} onDelete={vi.fn()} onClose={vi.fn()}
      onCreateStudioMaster={vi.fn()} studioMaster={null}
    /></AppProvider>);
    expect(screen.queryByText(/Потренируйте попадание/)).not.toBeInTheDocument();
    expect(screen.getByText(/Все показатели на максимуме/)).toBeInTheDocument();
  });
  it("labels the selected finished analysis as ready even when the recording list has an older status", () => {
    render(
      <AppProvider>
        <PerformanceAnalysisModal
          analysis={analysis}
          recordings={[
            { ...recording, analyzed: false, analysisStatus: "Running" },
            { ...recording, id: "take-2", analyzed: false, analysisStatus: "NotAnalyzed" },
          ]}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          onCreateStudioMaster={vi.fn()}
          studioMaster={null}
        />
      </AppProvider>,
    );

    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.getByText("Запись 1 из 2 · Анализ готов")).toBeInTheDocument();
    expect(screen.queryByText(/анализируется/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Следующая запись" }));
    expect(screen.getByText("Запись 2 из 2")).toBeInTheDocument();
    expect(screen.queryByText(/Анализ готов/)).not.toBeInTheDocument();
  });

  it("starts premium mastering for the analysed take and shows its progress", () => {
    const onCreateStudioMaster = vi.fn();
    const view = render(
      <AppProvider>
        <PerformanceAnalysisModal
          analysis={analysis}
          recordings={[recording]}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          onCreateStudioMaster={onCreateStudioMaster}
          studioMaster={null}
        />
      </AppProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Создать Studio Master" }),
    );

    expect(onCreateStudioMaster).toHaveBeenCalledWith(recording);

    view.rerender(
      <AppProvider>
        <PerformanceAnalysisModal
          analysis={analysis}
          recordings={[recording]}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          onCreateStudioMaster={onCreateStudioMaster}
          studioMaster={{
            recordingId: recording.id,
            stage: "Balancing",
            progress: 46,
          }}
        />
      </AppProvider>,
    );
    expect(screen.getByText(/46%/)).toBeInTheDocument();
  });
});
