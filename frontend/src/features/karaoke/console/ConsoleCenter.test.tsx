import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../app/AppContext";
import { ConsoleCenter } from "./ConsoleCenter";

describe("ConsoleCenter tempo", () => {
  it("shows musical BPM and changes it one BPM at a time", () => {
    const onSpeedChange = vi.fn();
    render(
      <AppProvider>
        <ConsoleCenter
          state={{ kind: "playing" }}
          position={10}
          duration={100}
          speed={0.75}
          baseBpm={120}
          keyShift={0}
          range={null}
          locked={false}
          seekLocked={false}
          onSeek={vi.fn()}
          onTogglePlay={vi.fn()}
          onStop={vi.fn()}
          onSpeedChange={onSpeedChange}
          onKeyChange={vi.fn()}
        />
      </AppProvider>,
    );

    expect(screen.getByText("90 BPM")).toBeInTheDocument();
    expect(screen.queryByText("0.75×")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Быстрее" }));
    expect(onSpeedChange).toHaveBeenCalledWith(91 / 120);
  });
});
