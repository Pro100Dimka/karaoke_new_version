import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { audioClient } from "../../services/audioClient";
import { AudioTests } from "./AudioTests";

vi.mock("../../services/audioClient", () => ({ audioClient: { setMixer: vi.fn(async () => undefined), setDspParameter: vi.fn(async () => undefined), setDspEnabled: vi.fn(async () => undefined) } }));
vi.mock("../../services/desktopClient", () => ({ desktopClient: { setAppIcon: vi.fn(async () => undefined) } }));

describe("AudioTests", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies the noise control to AudioService and labels it as Noise", async () => {
    render(<AppProvider><AudioTests runtime={{ backend: "WASAPI Shared", sampleRate: 48000, periodFrames: 256, endpointBufferFrames: 256, estimatedLatencyMs: 10 }} audioAvailable microphoneIssue={false} inputLevel={0} testingInput={false} onToggleInputTest={() => undefined} onPlayTestSound={() => undefined} /></AppProvider>);
    const input = screen.getByLabelText("Шум");
    fireEvent.change(input, { target: { value: "0.5" } });
    fireEvent.blur(input);
    await waitFor(() => expect(audioClient.setDspParameter).toHaveBeenCalledWith("noise.threshold", 0.125));
    expect(audioClient.setDspEnabled).toHaveBeenCalledWith(true);
  });
});
