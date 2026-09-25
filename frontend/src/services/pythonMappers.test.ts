import { describe, expect, it } from "vitest";
import { mapJob, mapSong, type BackendJob, type BackendSong } from "./pythonMappers";

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

  it("maps original filename and detected musical metadata", () => {
    const song = mapSong({
      songId: "song-2",
      title: "Title",
      artist: "Artist",
      album: null,
      originalFilename: "Artist - Original.wav",
      detectedBpm: 128.5,
      detectedKey: "Am",
      duration: 180,
      language: "Auto",
      status: "Ready",
      activeRevision: 2,
      projectFormatVersion: 2,
      coverState: "Custom",
      createdAt: "2026-01-01T00:00:00Z"
    } satisfies BackendSong);

    expect(song).toMatchObject({
      filename: "Artist - Original.wav",
      detectedBpm: 128.5,
      detectedKey: "Am"
    });
  });
});

describe("processing job mapping", () => {
  it("keeps processing timestamps used to show elapsed time", () => {
    const job = mapJob({
      jobId: "job-1",
      type: "SongProcessing",
      state: "Succeeded",
      entityId: "song-1",
      stage: "Completed",
      stageProgress: 1,
      overallProgress: 1,
      error: null,
      startedAt: "2026-09-25T12:00:00Z",
      finishedAt: "2026-09-25T12:03:17Z"
    } satisfies BackendJob);

    expect(job).toMatchObject({
      startedAt: "2026-09-25T12:00:00Z",
      finishedAt: "2026-09-25T12:03:17Z"
    });
  });
});
