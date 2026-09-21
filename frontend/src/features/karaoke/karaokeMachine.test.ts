import { describe, expect, it } from "vitest";
import { reduceKaraoke, type KaraokeState } from "./karaokeMachine";

describe("karaoke machine", () => {
  it("prepares before it can play", () => {
    const preparing: KaraokeState = { kind: "preparing" };
    expect(reduceKaraoke(preparing, { type: "PLAY" })).toEqual(preparing);
    expect(reduceKaraoke(preparing, { type: "PREPARED" })).toEqual({ kind: "ready" });
  });

  it("never resumes playback by itself after audio recovery", () => {
    const recovering = reduceKaraoke({ kind: "playing" }, { type: "AUDIO_LOST" });
    expect(recovering).toEqual({ kind: "recovering" });
    expect(reduceKaraoke(recovering, { type: "AUDIO_RECOVERED" })).toEqual({ kind: "paused" });
  });

  it("finalizes through stopping before finished", () => {
    const stopping = reduceKaraoke({ kind: "playing" }, { type: "STOPPING" });
    expect(stopping).toEqual({ kind: "stopping" });
    expect(reduceKaraoke(stopping, { type: "FINISH" })).toEqual({ kind: "finished" });
  });

  it("can repeat from finished and fail from anywhere", () => {
    expect(reduceKaraoke({ kind: "finished" }, { type: "RESTART" })).toEqual({ kind: "ready" });
    const error = { code: "X", message: "boom", source: "audio" } as const;
    expect(reduceKaraoke({ kind: "paused" }, { type: "FAIL", error }).kind).toBe("failed");
  });
});
