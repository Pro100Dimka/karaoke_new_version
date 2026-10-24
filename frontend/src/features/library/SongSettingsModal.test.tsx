import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import { LibraryProvider } from "../../app/LibraryProvider";
import type { SongDto } from "../../contracts/models";
import { SongSettingsModal } from "./SongSettingsModal";

const renderSettings = (status: SongDto["status"] = "ready", overrides: Partial<SongDto> = {}) => {
  const song: SongDto = {
    id: "existing", title: "Song", artist: "Artist", language: "Auto", status,
    durationSeconds: 200, createdAt: "2026-10-20", coverState: "Fallback",
    activeRevision: 2, projectFormatVersion: 1,
    ...overrides,
  };
  const onReprocess = vi.fn();
  render(<MemoryRouter><AppProvider><LibraryProvider>
    <SongSettingsModal song={song} onReprocess={onReprocess}
      onClose={vi.fn()} onSave={vi.fn()} onRemoveCover={vi.fn()}
      onOpenFolder={vi.fn()} onDelete={vi.fn()} />
  </LibraryProvider></AppProvider></MemoryRouter>);
  return { song, onReprocess };
};

describe("existing song lyric realignment", () => {
  it("previews discovered artwork, explains the video override and keeps deletion out of the save row", () => {
    renderSettings("ready", { artworkUrl: "https://example.org/cover.jpg", videoUrl: "https://example.org/video" });
    expect(screen.getByRole("img", { name: "Artist — Song" })).toHaveAttribute("src", "https://example.org/cover.jpg");
    expect(screen.getByText(/Найденный клип/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Удалить песню" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Язык Определять автоматически" })).toHaveTextContent("Определять автоматически");
  });
  it("offers a separate word and note realignment action and explains manual edit preservation", () => {
    const { song, onReprocess } = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Уточнить слова и ноты" }));
    expect(onReprocess).toHaveBeenCalledWith(song, "lyrics");
    expect(screen.getByText(/Ручные изменения сохраняются/)).toBeInTheDocument();
  });

  it.each(["queued", "processing", "not-processed"] as const)(
    "does not offer realignment while the song is %s",
    (status) => {
      renderSettings(status);
      expect(screen.getByRole("button", { name: "Уточнить слова и ноты" })).toBeDisabled();
    },
  );
});
