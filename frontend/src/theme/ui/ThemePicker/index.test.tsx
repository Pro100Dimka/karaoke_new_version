import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../app/AppContext";
import ThemePicker from ".";

describe("ThemePicker", () => {
  it("animates only the selected icon without drawing a card outline", () => {
    render(
      <AppProvider>
        <ThemePicker value="dark" onChange={vi.fn()} />
      </AppProvider>,
    );

    const selected = screen.getByRole("button", { name: "Тёмная" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected.querySelector(".brandIconMotion")).toHaveAttribute("data-glow", "false");
    expect(selected.querySelector(".brandIconMotionSweepAccent")).toHaveAttribute("stop-color", "#ff153f");
    expect(selected.querySelector(".brandIconMotionSweepHighlight")).toHaveAttribute("stop-color", "#ffe0d6");
    expect(selected.querySelector(".themeOptionGlow")).not.toBeInTheDocument();
    expect(selected.querySelector(".themeOptionSweep")).not.toBeInTheDocument();
  });
});
