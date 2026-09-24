import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { SongDto } from "../../contracts/models";
import { SongCard, type SongCardHandlers } from "./SongCard";

vi.mock("./SongCoverArt", () => ({ SongCoverArt: () => <div data-testid="equalizer" /> }));

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
  artworkUrl: "https://img.example/cover.jpg",
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
  it("keeps artwork in a dedicated background layer behind readable card content", () => {
    render(
      <AppProvider>
        <SongCard song={song} handlers={handlers} />
      </AppProvider>,
    );

    const equalizer = screen.getByTestId("equalizer");
    expect(equalizer.parentElement).toHaveClass("songCardEqualizer");
    expect(equalizer.closest(".songCardDetails")).toBeInTheDocument();
    expect(equalizer.closest(".songCardContent")).toBeNull();
    const artwork = document.querySelector<HTMLImageElement>(".songCardArtwork")!;
    expect(artwork).not.toBeNull();
    expect(artwork).toHaveClass("songCardArtwork");
    expect(artwork).toHaveAttribute("src", song.artworkUrl);
    expect(artwork.parentElement).toHaveClass("songCardArtworkLayer");
    expect(artwork.closest(".songCardDetails")).toHaveClass("songCardDetails--artwork");
    expect(artwork.closest(".songCardContent")).toBeNull();
    expect(document.querySelector(".songCardContent")).toBeInTheDocument();
  });

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
