import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { SongStatusBadge } from "./SongStatusBadge";

describe("SongStatusBadge", () => {
  it("renders the localized status text", () => {
    render(
      <AppProvider>
        <SongStatusBadge status="ready" />
      </AppProvider>
    );

    expect(screen.getByText("Готово")).toBeInTheDocument();
  });
});
