import { QueryProvider } from "../../../../test/QueryProvider";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AnalysisDto, RecordingDto } from "../../../../contracts/models";
import { PerformanceAnalysisModal } from "./index";

vi.mock("../recordings/RecordingPlayer", () => ({
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
  it("identifies the song in the new title and plays the selected take without a navigator", () => {
    render(<QueryProvider application><PerformanceAnalysisModal analysis={analysis}
      recordings={[{ ...recording, displayName: "Концертный дубль" }]}
      song={{ title: "Километры", artist: "Wildways" } as import("../../../../contracts/models").SongDto}
      onDelete={vi.fn()} onClose={vi.fn()} onCreateStudioMaster={vi.fn()} studioMaster={null} /></QueryProvider>);
    expect(screen.getByRole("heading", { name: /Анализ исполнения.*Wildways — Километры/ })).toBeInTheDocument();
    expect(screen.getByText("player:take-1")).toBeInTheDocument();
    expect(screen.queryByText("Концертный дубль")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Следующая запись" })).not.toBeInTheDocument();
  });

  it("shows automatic analysis progress immediately and offers cancellation", () => {
    const cancel = vi.fn();
    render(<QueryProvider application><PerformanceAnalysisModal analysis={null} recordings={[recording]}
      pending={{ recordingId: recording.id, jobId: "job", state: "Queued", stage: "Queued", progress: 0 }}
      onCancelAnalysis={cancel} onDelete={vi.fn()} onClose={vi.fn()} onCreateStudioMaster={vi.fn()} studioMaster={null} /></QueryProvider>);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Ожидает свободных ресурсов")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Отменить анализ" }));
    expect(cancel).toHaveBeenCalledWith("job");
  });

  it("does not recommend correcting pitch when all measured metrics are perfect", () => {
    render(<QueryProvider application><PerformanceAnalysisModal
      analysis={{ ...analysis, score: 100, pitch: 100, rhythm: 100, stability: 100 }}
      recordings={[recording]} onDelete={vi.fn()} onClose={vi.fn()}
      onCreateStudioMaster={vi.fn()} studioMaster={null}
    /></QueryProvider>);
    expect(screen.queryByText(/Потренируйте попадание/)).not.toBeInTheDocument();
    expect(screen.getByText(/Все показатели на максимуме/)).toBeInTheDocument();
  });
  it("keeps the selected finished analysis even when the recording list has an older status", () => {
    const modal = (result: AnalysisDto) => (
      <QueryProvider application>
        <PerformanceAnalysisModal
          analysis={result}
          recordings={[
            { ...recording, analyzed: false, analysisStatus: "Running" },
            { ...recording, id: "take-2", analyzed: false, analysisStatus: "NotAnalyzed" },
          ]}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          onCreateStudioMaster={vi.fn()}
          studioMaster={null}
        />
      </QueryProvider>
    );
    const view = render(modal(analysis));

    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.getByText("player:take-1")).toBeInTheDocument();
    expect(screen.queryByText(/анализируется/)).not.toBeInTheDocument();
    view.rerender(modal({ ...analysis, recordingId: "take-2", score: 77 }));
    expect(screen.getByText("77")).toBeInTheDocument();
    expect(screen.getByText("player:take-2")).toBeInTheDocument();
    expect(screen.queryByText("player:take-1")).not.toBeInTheDocument();
  });

  it("starts premium mastering for the analysed take and shows its progress", () => {
    const onCreateStudioMaster = vi.fn();
    const view = render(
      <QueryProvider application>
        <PerformanceAnalysisModal
          analysis={analysis}
          recordings={[recording]}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          onCreateStudioMaster={onCreateStudioMaster}
          studioMaster={null}
        />
      </QueryProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Создать Studio Master" }),
    );

    expect(onCreateStudioMaster).toHaveBeenCalledWith(recording);

    view.rerender(
      <QueryProvider application>
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
      </QueryProvider>,
    );
    expect(screen.getByText(/46%/)).toBeInTheDocument();
  });
});
