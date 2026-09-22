import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { SongDto } from "../../contracts/models";
import { SongCard, type SongCardHandlers } from "./SongCard";

vi.mock("./SongCoverArt", () => ({ SongCoverArt: () => <div /> }));

const song: SongDto = {
  id: "song-1",
  title: "Song",
  artist: "Artist",
  status: "ready",
  durationSeconds: 180,
  activeRevision: 1,
  projectFormatVersion: 1,
  coverState: "Fallback",
  language: "Auto",
  createdAt: new Date().toISOString(),
};

const handlers = Object.fromEntries(
  [
    "onPlay",
    "onProcess",
    "onCancel",
    "onDetails",
    "onSettings",
    "onRecordings",
    "onOpenFolder",
    "onDelete",
    "onViewError",
  ].map((name) => [name, vi.fn()]),
) as unknown as SongCardHandlers;

describe("SongCard room selection", () => {
  it("offers the host a card button that selects this song for the room", () => {
    const onSelect = vi.fn();
    render(
      <AppProvider>
        <SongCard
          song={song}
          handlers={handlers}
          roomSelection={{ selected: false, onSelect }}
        />
      </AppProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Выберите песню" }));
    expect(onSelect).toHaveBeenCalledWith(song);
  });
});
