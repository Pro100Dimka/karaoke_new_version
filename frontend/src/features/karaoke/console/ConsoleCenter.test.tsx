import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../app/AppContext";
import { ConsoleCenter } from "./ConsoleCenter";

describe("ConsoleCenter tempo", () => {
  it("edits musical BPM through a number field and shows the concrete key", () => {
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
          keyLabel="Am"
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

    const tempo = screen.getByRole("spinbutton", { name: "Темп" });
    expect(tempo).toHaveValue(90);
    expect(screen.queryByText("0.75×")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Быстрее" })).not.toBeInTheDocument();
    expect(screen.getByText("Am")).toBeInTheDocument();
    fireEvent.change(tempo, { target: { value: "91" } });
    fireEvent.blur(tempo);
    expect(onSpeedChange).toHaveBeenCalledWith(91 / 120);
  });
});
