import { describe, expect, it } from "vitest";
import type { SongDto } from "../../contracts/models";
import { selectLibrarySongs } from "./librarySelectors";

const song = (patch: Partial<SongDto> & Pick<SongDto, "id" | "title" | "artist">): SongDto => ({
  language: "Auto",
  status: "ready",
  durationSeconds: 200,
  createdAt: "2026-01-01T00:00:00Z",
  coverState: "Fallback",
  activeRevision: 1,
  projectFormatVersion: 2,
  ...patch
});

const songs: readonly SongDto[] = [
  song({ id: "b", title: "Люди", artist: "Бумбокс", filename: "people.mp3", createdAt: "2026-02-01T00:00:00Z" }),
  song({ id: "a", title: "Журавлі", artist: "Хардкіс", filename: "zhuravli.flac", createdAt: "2026-03-01T00:00:00Z" }),
  song({ id: "c", title: "Пісня", artist: "Аліса", status: "processing", createdAt: "2026-01-15T00:00:00Z" })
];

const ids = (list: readonly SongDto[]) => list.map(item => item.id);
const base = {
  query: "",
  status: "all",
  language: "all",
  duration: "all",
  artwork: "all",
  sort: "title",
  direction: "asc",
} as const;

describe("selectLibrarySongs", () => {
  it("searches title, artist and filename case-insensitively", () => {
    expect(ids(selectLibrarySongs(songs, { ...base, query: "БУМБОКС" }))).toEqual(["b"]);
    expect(ids(selectLibrarySongs(songs, { ...base, query: "zhuravli" }))).toEqual(["a"]);
  });

  it("matches partial substrings after Unicode normalization", () => {
    expect(ids(selectLibrarySongs(songs, { ...base, query: "  ард " }))).toEqual(["a"]);
    expect(ids(selectLibrarySongs(songs, { ...base, query: "урав" }))).toEqual(["a"]);
  });

  it("filters by status", () => {
    expect(ids(selectLibrarySongs(songs, { ...base, status: "processing" }))).toEqual(["c"]);
  });

  it("combines language, duration and artwork filters", () => {
    const catalogue = [
      song({ id: "short", title: "Short", artist: "A", language: "English", durationSeconds: 120, artworkUrl: "cover.jpg" }),
      song({ id: "long", title: "Long", artist: "B", language: "English", durationSeconds: 380 }),
      song({ id: "uk", title: "Українська", artist: "C", language: "Ukrainian", durationSeconds: 120, artworkUrl: "cover.jpg" }),
    ];
    expect(ids(selectLibrarySongs(catalogue, { ...base, language: "English", duration: "short", artwork: "with" }))).toEqual(["short"]);
  });

  it("applies one shared direction to every sort field", () => {
    expect(ids(selectLibrarySongs(songs, { ...base, direction: "desc" }))).toEqual(["c", "b", "a"]);
  });

  it("supports every sort field", () => {
    expect(ids(selectLibrarySongs(songs, { ...base, sort: "recent" }))).toEqual(["c", "b", "a"]);
    expect(ids(selectLibrarySongs(songs, { ...base, sort: "artist" }))).toEqual(["c", "b", "a"]);
    expect(ids(selectLibrarySongs(songs, base))).toEqual(["a", "b", "c"]);
    expect(ids(selectLibrarySongs(songs, { ...base, sort: "played" }, { c: 30, b: 10 }))).toEqual(["a", "b", "c"]);
    expect(ids(selectLibrarySongs(songs, { ...base, sort: "duration" }))).toEqual(["a", "b", "c"]);
    expect(ids(selectLibrarySongs(songs, { ...base, sort: "bpm" }))).toEqual(["a", "b", "c"]);
  });

  it("breaks ties by title, artist and id so order is deterministic", () => {
    const twins = [song({ id: "z", title: "Same", artist: "A" }), song({ id: "y", title: "Same", artist: "A" })];
    expect(ids(selectLibrarySongs(twins, { ...base, sort: "recent" }))).toEqual(["y", "z"]);
  });
});
