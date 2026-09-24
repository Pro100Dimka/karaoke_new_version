import { describe, expect, it } from "vitest";
import { detectedSongMetadata, recordingStatusLabels } from "./songMetadataPresentation";

describe("song and recording metadata presentation", () => {
  it("exposes detected tempo and key without inventing values", () => {
    expect(detectedSongMetadata({ detectedBpm: 128.46, detectedKey: "Am" })).toEqual({
      bpm: "128.5 BPM",
      key: "Am"
    });
    expect(detectedSongMetadata({})).toEqual({ bpm: "—", key: "—" });
  });

  it("keeps recovered and failed file states distinct from analysis state", () => {
    expect(recordingStatusLabels("RecoveredIncomplete", "NotAnalyzed")).toEqual([
      "recordingRecoveredIncomplete",
      "analysisNotAnalyzed"
    ]);
  });
});
