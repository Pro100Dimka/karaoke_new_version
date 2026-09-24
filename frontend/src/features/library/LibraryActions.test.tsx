import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { LibraryActions } from "./LibraryActions";

const renderActions = (roomRole?: "host" | "participant") => {
  const onCollaborativeControlChange = vi.fn();
  const onFiltersApply = vi.fn();
  render(
    <AppProvider>
      <LibraryActions
        query=""
        filters={{ status: "all", language: "all", duration: "all", artwork: "all", sort: "recent", direction: "desc" }}
        activeJobs={0}
        roomRole={roomRole}
        collaborativeControl={false}
        onCollaborativeControlChange={onCollaborativeControlChange}
        onQueryChange={vi.fn()}
        onFiltersApply={onFiltersApply}
        onOpenRoom={vi.fn()}
        onOpenProcessing={vi.fn()}
        onAddSong={vi.fn()}
      />
    </AppProvider>
  );
  return { onCollaborativeControlChange, onFiltersApply };
};

describe("LibraryActions room authority", () => {
  it("hides the room button for participants and shows collaborative control only to the host", () => {
    renderActions("participant");
    expect(screen.queryByRole("button", { name: "Онлайн-комната" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Совместное управление" })).not.toBeInTheDocument();
    cleanup();

    const { onCollaborativeControlChange } = renderActions("host");
    expect(screen.queryByRole("button", { name: "Онлайн-комната" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Совместное управление" }));
    expect(onCollaborativeControlChange).toHaveBeenCalledWith(true);
  });

  it("applies sorting and direction immediately without apply or reset actions", () => {
    const { onFiltersApply } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Фильтры и сортировка" }));

    expect(screen.queryByRole("button", { name: "Применить" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Сбросить" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Название" }));
    expect(onFiltersApply).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "title", direction: "desc" }));
    fireEvent.click(screen.getByRole("button", { name: "По убыванию" }));
    expect(onFiltersApply).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "recent", direction: "asc" }));
  });
});
