import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RotaryKnob from ".";

describe("RotaryKnob", () => {
  it("renders the illuminated metal dial, graduated scale and value marker", () => {
    const { container } = render(
      <RotaryKnob label="Микрофон" value={0.68} min={0} max={1} displayFactor={100} />,
    );

    expect(container.querySelector(".ui-rotary-knob__metal")).toBeInTheDocument();
    expect(container.querySelector(".ui-rotary-knob__track-active")).toBeInTheDocument();
    expect(container.querySelectorAll(".ui-rotary-knob__tick")).toHaveLength(41);
    expect(container.querySelectorAll(".ui-rotary-knob__scale-label")).toHaveLength(5);
    expect(container.querySelector(".ui-rotary-knob__thumb")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Микрофон" })).toHaveAttribute(
      "aria-valuetext",
      "68%",
    );
    expect(screen.getByText("68%")).toBeInTheDocument();
  });
});
