import { describe, expect, it } from "vitest";
import type { SongStatus } from "../../contracts/models";
import { songCanPlay, songStatusPresentation } from "./songPresentation";

const statuses = [
  "not-processed",
  "queued",
  "processing",
  "ready",
  "failed",
  "importing",
  "invalid"
] as const satisfies readonly SongStatus[];

describe("song state/action matrix", () => {
  it("defines presentation for every song status", () => {
    expect(Object.keys(songStatusPresentation).sort()).toEqual([...statuses].sort());
  });

  it("allows Play Karaoke only for ready songs", () => {
    expect(statuses.filter(songCanPlay)).toEqual(["ready"]);
  });

  it("never offers Delete or Play while a song is queued or processing", () => {
    for (const status of ["queued", "processing"] as const) {
      expect(songStatusPresentation[status].actions).not.toContain("delete");
      expect(songStatusPresentation[status].actions).not.toContain("play");
    }
  });

  it("offers Repair/Reprocess, details and delete for an invalid project", () => {
    expect(songStatusPresentation.invalid.actions).toEqual(["viewError", "reprocess", "folder", "delete"]);
  });
});
