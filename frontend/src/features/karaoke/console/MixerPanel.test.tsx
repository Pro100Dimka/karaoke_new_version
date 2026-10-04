import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../app/AppContext";
import { MixerPanel } from "./MixerPanel";

describe("MixerPanel", () => {
  it("renders monitoring as the microphone knob action instead of a switch", () => {
    const onToggleMonitoring = vi.fn();
    render(
      <AppProvider>
        <MixerPanel
          gains={{ mic: 0.4, music: 0.5, reference: 0, melody: 0, master: 1 }}
          effects={{ echo: 0.1, reverb: 0.2, delay: 0.24, autoTune: 0 }}
          monitoring={false}
          microphoneAvailable
          onGainChange={vi.fn()}
          onEffectChange={vi.fn()}
          onToggleMonitoring={onToggleMonitoring}
        />
      </AppProvider>,
    );

    expect(screen.queryByRole("checkbox", { name: "Мониторинг" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Мониторинг" });
    const mic = screen.getByRole("slider", { name: "Мик" }).closest(".consoleMicrophone");
    expect(mic).toContainElement(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(onToggleMonitoring).toHaveBeenCalledTimes(1);
  });

  it("resets vocal and melody channels to silence on a body double click", () => {
    const onGainChange = vi.fn();
    const { container } = render(
      <AppProvider>
        <MixerPanel
          gains={{ mic: 0.4, music: 0.5, reference: 0.6, melody: 0.7, master: 1 }}
          effects={{ echo: 0.1, reverb: 0.2, delay: 0.24, autoTune: 0 }}
          monitoring={false}
          microphoneAvailable
          onGainChange={onGainChange}
          onEffectChange={vi.fn()}
          onToggleMonitoring={vi.fn()}
        />
      </AppProvider>,
    );

    for (const [label, channel] of [["Вокал", "reference"], ["Мелодия", "melody"]] as const) {
      const slider = screen.getByRole("slider", { name: label });
      expect(container).toContainElement(slider);
      fireEvent.doubleClick(slider);
      expect(onGainChange).toHaveBeenLastCalledWith(channel, 0);
    }
  });
});
