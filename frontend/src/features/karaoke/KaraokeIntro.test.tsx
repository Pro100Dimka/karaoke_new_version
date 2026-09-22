import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../../app/AppContext";
import type { SongDto } from "../../contracts/models";
import { KaraokeIntro } from "./KaraokeIntro";

describe("KaraokeIntro", () => {
  it("shows recognized cover, album and genre before playback", () => {
    const song = {
      id: "song-1",
      title: "Running Up That Hill",
      artist: "Kate Bush",
      album: "Hounds of Love",
      genre: "Pop",
      artworkUrl: "https://img.example/cover.jpg"
    } as SongDto;

    render(
      <AppProvider>
        <KaraokeIntro song={song} onStart={vi.fn()} onDone={vi.fn()} />
      </AppProvider>
    );

    expect(screen.getByRole("img", { name: song.title })).toHaveAttribute("src", song.artworkUrl);
    expect(screen.getByText("Hounds of Love")).toBeInTheDocument();
    expect(screen.getByText("Pop")).toBeInTheDocument();
  });
});
