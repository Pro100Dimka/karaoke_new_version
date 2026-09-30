import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../../app/AppContext";
import { audioClient } from "../../../../services/audioClient";
import { useVoiceChain } from "../../../karaoke/console/voiceChain";
import { AudioTests } from "./AudioTests";
import { AcousticCalibration } from "./AcousticCalibration";

// The settings knob only stores its value; the app-wide voice chain plays it.
const VoiceChain = () => {
  useVoiceChain();
  return null;
};

vi.mock("../../../../services/audioClient", () => ({
  audioClient: {
    setMixer: vi.fn(async () => undefined),
    setDspParameter: vi.fn(async () => undefined),
    setDspEnabled: vi.fn(async () => undefined),
    measureAcousticLatency: vi.fn(async () => 28.2),
  },
}));
vi.mock("../../../../app/NotificationsProvider", () => ({ useNotify: () => vi.fn() }));
vi.mock("../../../../services/desktopClient", () => ({
  desktopClient: { setAppIcon: vi.fn(async () => undefined) },
}));

describe("AudioTests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("measures the hidden latency on request and keeps it for this device setup", async () => {
    render(
      <AppProvider>
        <AudioTests
          runtime={{ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
            endpointBufferFrames: 1056, estimatedLatencyMs: 20 }}
          audioAvailable microphoneIssue={false} inputLevel={0} testingInput={false}
          onToggleInputTest={() => undefined} onPlayTestSound={() => undefined}
        />
      </AppProvider>,
    );
    expect(screen.getByText("не измерена")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Измерить" }));
    await waitFor(() => expect(screen.getByText("28 мс")).toBeInTheDocument());
    expect(screen.queryByText(/беспроводные наушники/)).not.toBeInTheDocument();
    expect(audioClient.measureAcousticLatency).toHaveBeenCalledOnce();
  });

  it.each([40, null])("distinguishes the partial estimate from physical latency (%s)", estimatedLatencyMs => {
    render(
      <AppProvider>
        <AudioTests
          runtime={{ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
            endpointBufferFrames: 1056, estimatedLatencyMs }}
          audioAvailable microphoneIssue={false} inputLevel={0} testingInput={false}
          onToggleInputTest={() => undefined} onPlayTestSound={() => undefined}
        />
      </AppProvider>,
    );
    // The caveat lives in the tooltip of the info button next to the estimate.
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Полная задержка: не измерена" }));
    expect(screen.getByText("Полная задержка: не измерена")).toBeInTheDocument();
    expect(screen.getByText(/Расчёт по данным аудиосистемы/)).toBeInTheDocument();
    expect(screen.getByText("Не учитывает скрытую задержку оборудования. Полную задержку можно определить только физическим замером.")).toBeInTheDocument();
    if (estimatedLatencyMs !== null) expect(screen.getByText(/≈40 мс/)).toBeInTheDocument();
    else expect(screen.queryByText(/\d.*мс/)).not.toBeInTheDocument();
  });

  it("clears a local measurement when the audio session changes", async () => {
    const runtime = { backend: "WASAPI Shared" as const, sampleRate: 48000,
      periodFrames: 480, endpointBufferFrames: 1056, estimatedLatencyMs: 20 };
    const view = (context: string, calibratedLatencyMs?: number) => (
      <AppProvider>
        <AcousticCalibration audioAvailable runtime={{ ...runtime,
          calibrationContext: context, calibratedLatencyMs }} />
      </AppProvider>
    );
    const { rerender } = render(view("session-a"));
    fireEvent.click(screen.getByRole("button", { name: "Измерить" }));
    await waitFor(() => expect(screen.getByText("28 мс")).toBeInTheDocument());
    rerender(view("session-b"));
    expect(screen.getByText("не измерена")).toBeInTheDocument();
    rerender(view("session-b", 0));
    expect(screen.getByText("0 мс")).toBeInTheDocument();
  });

  it("does not show a stale numeric estimate when AudioService is unavailable", () => {
    render(
      <AppProvider>
        <AudioTests
          runtime={{ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 480,
            endpointBufferFrames: 1056, estimatedLatencyMs: 40 }}
          audioAvailable={false} microphoneIssue={false} inputLevel={0} testingInput={false}
          onToggleInputTest={() => undefined} onPlayTestSound={() => undefined}
        />
      </AppProvider>,
    );
    expect(screen.queryByText(/40[.,]0/)).not.toBeInTheDocument();
  });

  it("applies the noise control to AudioService and labels it as Noise", async () => {
    render(
      <AppProvider>
        <VoiceChain />
        <AudioTests
          runtime={{
            backend: "WASAPI Shared",
            sampleRate: 48000,
            periodFrames: 256,
            endpointBufferFrames: 256,
            estimatedLatencyMs: 10,
          }}
          audioAvailable
          microphoneIssue={false}
          inputLevel={0}
          testingInput={false}
          onToggleInputTest={() => undefined}
          onPlayTestSound={() => undefined}
        />
      </AppProvider>,
    );
    const input = screen.getByLabelText("Шум");
    fireEvent.change(input, { target: { value: "0.5" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(audioClient.setDspParameter).toHaveBeenCalledWith(
        "noise.threshold",
        0.015,
      ),
    );
    expect(audioClient.setDspParameter).toHaveBeenCalledWith(
      "noise.reduction",
      0.625,
    );
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(true);
  });
});
