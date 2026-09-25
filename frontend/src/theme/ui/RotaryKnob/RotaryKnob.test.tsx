import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RotaryKnob from ".";

describe("RotaryKnob", () => {
  it("renders the illuminated metal dial and value marker", () => {
    const { container } = render(
      <RotaryKnob label="Микрофон" value={0.68} min={0} max={1} displayFactor={100} size="md" />,
    );

    expect(container.querySelector(".ui-rotary-knob__artwork")).toBeInTheDocument();
    expect(container.querySelector(".ui-rotary-knob__track-active-art")).toBeInTheDocument();
    expect(container.querySelector(".ui-rotary-knob__pointer-art")).toBeInTheDocument();
    expect(container.querySelector(".ui-rotary-knob__thumb-art")).toBeInTheDocument();
    expect(container.querySelector('mask[id$="-track"] circle')).toHaveAttribute("stroke-width", "8");
    expect(container.querySelector('mask[id$="-progress"] circle')).toHaveAttribute("stroke-width", "9");
    expect(container.querySelector(".ui-rotary-knob__metal")).not.toBeInTheDocument();
    expect(container.querySelector(".ui-rotary-knob__arc-sheen")).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Микрофон" })).toHaveAttribute(
      "aria-valuetext",
      "68%",
    );
    expect(screen.getByText("68%")).toBeInTheDocument();
    expect(container.querySelector(".ui-rotary-knob")).toHaveStyle({
      "--rotary-size": "clamp(4.5rem, min(6.25vw, 11.5vh), 7rem)",
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("defaults to zero when value is omitted", () => {
    render(<RotaryKnob label="Громкость" min={0} max={1} />);
    expect(screen.getByRole("slider", { name: "Громкость" })).toHaveValue("0");
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("only renders the optional action button when btnProps are provided", () => {
    const onButtonClick = vi.fn();
    render(
      <RotaryKnob
        label="Музыка"
        value={0.68}
        min={0}
        max={1}
        btnProps={{
          icon: <span data-testid="button-icon">icon</span>,
          onClick: onButtonClick,
          tooltip: "Отключить музыку",
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Отключить музыку" });
    expect(button).toHaveAttribute("title", "Отключить музыку");
    expect(screen.getByTestId("button-icon")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onButtonClick).toHaveBeenCalledTimes(1);
  });

  it("does not jump on a body press and resets on a body double click", () => {
    const onChange = vi.fn();
    const { container } = render(
      <RotaryKnob
        label="Музыка"
        value={0.68}
        min={0}
        max={1}
        defaultValue={0.25}
        onChange={onChange}
      />,
    );

    const body = container.querySelector(".ui-rotary-knob__rotating-dial") as Element;
    const bodyArtwork = container.querySelector(".ui-rotary-knob__body-art") as SVGElement;
    const [viewBoxX, viewBoxY, viewBoxWidth, viewBoxHeight] = bodyArtwork
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number) as [number, number, number, number];
    const renderedX = Number(bodyArtwork.getAttribute("x"));
    const renderedY = Number(bodyArtwork.getAttribute("y"));
    const renderedWidth = Number(bodyArtwork.getAttribute("width"));
    const renderedHeight = Number(bodyArtwork.getAttribute("height"));
    expect(renderedX + ((628.5 - viewBoxX) / viewBoxWidth) * renderedWidth).toBeCloseTo(100, 1);
    expect(renderedY + ((612 - viewBoxY) / viewBoxHeight) * renderedHeight).toBeCloseTo(100, 1);

    fireEvent.pointerDown(body, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(body, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(body, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(body, { button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    const root = container.querySelector(".ui-rotary-knob") as HTMLElement;
    expect(root).toBeInTheDocument();
    fireEvent.doubleClick(root);
    expect(onChange).toHaveBeenLastCalledWith(0.25);
  });

  it("applies rapid value changes to the dial without visual interpolation", () => {
    const { container, rerender } = render(
      <RotaryKnob label="Музыка" value={0.1} min={0} max={1} />,
    );

    rerender(<RotaryKnob label="Музыка" value={0.9} min={0} max={1} />);
    rerender(<RotaryKnob label="Музыка" value={0.2} min={0} max={1} />);

    const dial = container.querySelector(".ui-rotary-knob__rotating-dial") as SVGGElement;
    expect(dial).toHaveAttribute("transform", "rotate(234 100 100)");
    expect(dial).toHaveStyle({ transition: "none" });
  });
});
