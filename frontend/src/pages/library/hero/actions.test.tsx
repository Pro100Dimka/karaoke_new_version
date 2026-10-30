import { QueryProvider } from "../../../test/QueryProvider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LibraryActions } from "./actions";

const renderActions = (roomRole?: "host" | "participant") => {
  const onCollaborativeControlChange = vi.fn();
  const onFiltersApply = vi.fn();
  render(
    <QueryProvider application>
      <LibraryActions
        roomRole={roomRole}
        collaborativeControl={false}
        onCollaborativeControlChange={onCollaborativeControlChange}
        onViewChange={onFiltersApply}
        onOpenRoom={vi.fn()}
      />
    </QueryProvider>,
  );
  return { onCollaborativeControlChange, onFiltersApply };
};

describe("LibraryActions room authority", () => {
  it("hides the room button for participants and shows collaborative control only to the host", () => {
    renderActions("participant");
    expect(
      screen.queryByRole("button", { name: "Онлайн-комната" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Совместное управление" }),
    ).not.toBeInTheDocument();
    cleanup();

    const { onCollaborativeControlChange } = renderActions("host");
    expect(
      screen.queryByRole("button", { name: "Онлайн-комната" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("switch", { name: "Совместное управление" }),
    );
    expect(onCollaborativeControlChange).toHaveBeenCalledWith(true);
  });
});
