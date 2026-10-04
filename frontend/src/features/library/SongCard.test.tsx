import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { SongDto } from "../../contracts/models";
import { SongCard, type SongCardHandlers } from "./SongCard";

vi.mock("./useRadioSpectrum", () => ({ useRadioSpectrum: () => undefined }));

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
  it("is a library media card with the song's cover, title and status", () => {
    render(
      <AppProvider>
        <SongCard song={song} handlers={handlers} />
      </AppProvider>,
    );

    const card = document.querySelector(".songCard.ad-media-card") as HTMLElement;
    expect(card).toHaveAttribute("aria-label", "Artist — Song");
    expect(card.querySelector("img")).toHaveAttribute("src", song.artworkUrl);
    expect(screen.getByText("Song")).toBeInTheDocument();
    expect(screen.getByText("Artist")).toBeInTheDocument();
  });

  it("keeps the standard play action while the parent handles room selection", () => {
    const onPlay = vi.fn();
    render(
      <AppProvider>
        <SongCard
          song={song}
          handlers={{ ...handlers, onPlay }}
          roomSelection={{ role: "host", selected: false }}
        />
      </AppProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Запустить караоке" }));
    expect(onPlay).toHaveBeenCalledWith(song);
  });
});
