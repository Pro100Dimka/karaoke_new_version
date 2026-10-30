import { QueryProvider } from "../../../test/QueryProvider";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Transport } from "./Transport";

describe("Transport room readiness", () => {
  it("disables every transport action while another participant is still preparing", () => {
    render(
      <QueryProvider application>
        <Transport
          state={{ kind: "playing" }}
          position={12}
          duration={180}
          seekLocked
          onSeek={vi.fn()}
          onTogglePlay={vi.fn()}
          onStop={vi.fn()}
        />
      </QueryProvider>,
    );

    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
  });
});
