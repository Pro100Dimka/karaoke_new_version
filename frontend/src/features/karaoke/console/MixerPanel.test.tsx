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
          gains={{ mic: 0.4, music: 0.5, reference: 0, melody: 0 }}
          effects={{ echo: 0.1, reverb: 0.2, delay: 0.24 }}
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
    const mic = screen.getByRole("slider", { name: "Мик" }).closest(".ui-rotary-knob");
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
          gains={{ mic: 0.4, music: 0.5, reference: 0.6, melody: 0.7 }}
          effects={{ echo: 0.1, reverb: 0.2, delay: 0.24 }}
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
      const root = slider.closest(".ui-rotary-knob") as HTMLElement;
      const body = root.querySelector(".ui-rotary-knob__rotating-dial") as Element;
      expect(container).toContainElement(root);
      fireEvent.pointerDown(body, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(body, { button: 0, pointerId: 1 });
      fireEvent.pointerDown(body, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(body, { button: 0, pointerId: 1 });
      fireEvent.doubleClick(root);
      expect(onGainChange).toHaveBeenLastCalledWith(channel, 0);
    }
  });
});
