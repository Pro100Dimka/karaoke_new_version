import { describe, expect, it } from "vitest";
import type { SongStatus } from "../../contracts/models";
import { songStatusPresentation } from "./songPresentation";

const statuses = [
  "not-processed",
  "queued",
  "processing",
  "ready",
  "failed",
  "importing",
  "invalid",
] as const satisfies readonly SongStatus[];

describe("song state/action matrix", () => {
  it.each(statuses)("never offers processing an existing %s song", (status) => {
    const presentation = songStatusPresentation[status];
    expect(presentation.actions).not.toContain("process");
    expect(presentation.actions).not.toContain("reprocess");
    expect(["process", "repair"]).not.toContain(presentation.primaryAction);
  });
  it("does not offer full reprocessing for a ready song", () => {
    expect(songStatusPresentation.ready.actions).not.toContain("reprocess");
  });

  it("defines presentation for every song status", () => {
    expect(Object.keys(songStatusPresentation).sort()).toEqual(
      [...statuses].sort(),
    );
  });

  it("allows Play Karaoke only for ready songs", () => {
    expect(
      statuses.filter((status) =>
        (songStatusPresentation[status].actions as readonly string[]).includes(
          "play",
        ),
      ),
    ).toEqual(["ready"]);
  });

  it("never offers Delete or Play while a song is queued or processing", () => {
    for (const status of ["queued", "processing"] as const) {
      expect(songStatusPresentation[status].actions).not.toContain("delete");
      expect(songStatusPresentation[status].actions).not.toContain("play");
    }
  });

  it("offers details, folder and deletion for an invalid project", () => {
    expect(songStatusPresentation.invalid.actions).toEqual([
      "viewError",
      "folder",
      "delete",
    ]);
  });
});
