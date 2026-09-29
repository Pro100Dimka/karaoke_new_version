import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SeekWaveform } from "./SeekWaveform";

describe("SeekWaveform", () => {
  it("keeps the song shape while progress changes and replaces it for newly loaded peaks", () => {
    const props = { peaks: null, position: 0, duration: 100, disabled: false, label: "Song", onSeek: vi.fn() };
    const { container, rerender } = render(<SeekWaveform {...props} />);
    const shape = () => container.querySelector(".seekWaveformBars")?.getAttribute("d");
    const placeholder = shape();
    rerender(<SeekWaveform {...props} position={50} />);
    expect(shape()).toBe(placeholder);
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(props.onSeek).toHaveBeenLastCalledWith(55);
    rerender(<SeekWaveform {...props} peaks={[0.1, 0.9, 0.4]} position={50} />);
    expect(shape()).not.toBe(placeholder);
    expect(container.querySelector("clipPath rect")).toHaveAttribute("width", "4.5");
    rerender(<SeekWaveform {...props} disabled position={50} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowLeft" });
    expect(props.onSeek).toHaveBeenCalledTimes(1);
  });
});
