import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { LibraryActions } from "./LibraryActions";

const renderActions = (roomRole?: "host" | "participant") => {
  const onCollaborativeControlChange = vi.fn();
  render(
    <AppProvider>
      <LibraryActions
        query=""
        filters={{ status: "all", sort: "recent" }}
        activeJobs={0}
        roomRole={roomRole}
        collaborativeControl={false}
        onCollaborativeControlChange={onCollaborativeControlChange}
        onQueryChange={vi.fn()}
        onFiltersApply={vi.fn()}
        onOpenRoom={vi.fn()}
        onOpenProcessing={vi.fn()}
        onAddSong={vi.fn()}
      />
    </AppProvider>
  );
  return onCollaborativeControlChange;
};

describe("LibraryActions room authority", () => {
  it("hides the room button for participants and shows collaborative control only to the host", () => {
    renderActions("participant");
    expect(screen.queryByRole("button", { name: "Онлайн-комната" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Совместное управление" })).not.toBeInTheDocument();
    cleanup();

    const change = renderActions("host");
    expect(screen.queryByRole("button", { name: "Онлайн-комната" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Совместное управление" }));
    expect(change).toHaveBeenCalledWith(true);
  });
});
