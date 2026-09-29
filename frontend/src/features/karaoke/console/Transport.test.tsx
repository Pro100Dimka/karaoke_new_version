import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../../app/AppContext";
import { Transport } from "./Transport";

describe("Transport room readiness", () => {
  it("disables every transport action while another participant is still preparing", () => {
    render(
      <AppProvider>
        <Transport
          state={{ kind: "playing" }}
          position={12}
          duration={180}
          seekLocked
          onSeek={vi.fn()}
          onTogglePlay={vi.fn()}
          onStop={vi.fn()}
        />
      </AppProvider>,
    );

    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});
