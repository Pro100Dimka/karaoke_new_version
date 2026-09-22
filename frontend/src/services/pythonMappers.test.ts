import { describe, expect, it } from "vitest";
import { mapSong, type BackendSong } from "./pythonMappers";

describe("song metadata mapping", () => {
  it("keeps recognized genre, artwork and music video for library and karaoke", () => {
    const song = mapSong({
      songId: "song-1",
      title: "Title",
      artist: "Artist",
      album: "Album",
      genre: "Rock",
      artworkUrl: "https://img.example/cover.jpg",
      videoUrl: "https://www.youtube.com/watch?v=video",
      recognitionProvider: "AudD",
      duration: 180,
      language: "English",
      status: "Ready",
      activeRevision: 1,
      projectFormatVersion: 2,
      coverState: "Fallback",
      createdAt: "2026-01-01T00:00:00Z"
    } satisfies BackendSong);

    expect(song).toMatchObject({
      genre: "Rock",
      artworkUrl: "https://img.example/cover.jpg",
      videoUrl: "https://www.youtube.com/watch?v=video",
      recognitionProvider: "AudD"
    });
  });
});
