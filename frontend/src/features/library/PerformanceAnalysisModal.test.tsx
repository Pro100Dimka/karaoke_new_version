import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { AnalysisDto, RecordingDto } from "../../contracts/models";
import { PerformanceAnalysisModal } from "./PerformanceAnalysisModal";

vi.mock("./RecordingPlayer", () => ({ RecordingPlayer: ({ recording }: { recording: RecordingDto }) => <div>player:{recording.id}</div> }));
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
  it("shows the takes, the players, the scores and the verdict", () => {
    render(
      <AppProvider>
        <PerformanceAnalysisModal analysis={analysis} recordings={[recording]} onDelete={vi.fn()} onClose={vi.fn()} onCreateStudioMaster={vi.fn()} studioMaster={null} />
      </AppProvider>,
    );

    expect(document.querySelector(".analysisDialog .analysisPlanet")).toBeInTheDocument();
    expect(document.querySelector(".analysisNavigator")).toBeInTheDocument();
    expect(document.querySelector(".analysisOriginal")).toBeInTheDocument();
    expect(document.querySelector(".analysisStudio")).toBeInTheDocument();
    expect(document.querySelectorAll(".analysisMetric")).toHaveLength(3);
    expect(document.querySelector(".analysisRecommendation .analysisLandscape")).toBeInTheDocument();
    expect(document.querySelector(".analysisRecommendation .analysisFlow")).toBeInTheDocument();
    expect(document.querySelector('[data-role="analysis-score"]')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Создать Studio Master" }));

    expect(onCreateStudioMaster).toHaveBeenCalledWith(recording);

    view.rerender(
      <AppProvider>
        <PerformanceAnalysisModal
          analysis={analysis}
          recordings={[recording]}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          onCreateStudioMaster={onCreateStudioMaster}
          studioMaster={{ recordingId: recording.id, stage: "Balancing", progress: 46 }}
        />
      </AppProvider>,
    );
    expect(screen.getByText(/46%/)).toBeInTheDocument();
  });

  it("replaces the action with a second player when the studio master is ready", () => {
    const master = {
      ...recording,
      id: "master-1",
      displayName: "Studio Master · Take",
      sourceRecordingId: recording.id,
    } as RecordingDto;

    render(
      <AppProvider>
        <PerformanceAnalysisModal
          analysis={analysis}
          recordings={[master, recording]}
          onDelete={vi.fn()}
          onClose={vi.fn()}
          onCreateStudioMaster={vi.fn()}
          studioMaster={null}
        />
      </AppProvider>,
    );

    expect(screen.getByText("player:take-1")).toBeInTheDocument();
    expect(screen.getByText("player:master-1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Создать Studio Master" })).not.toBeInTheDocument();
  });
});
