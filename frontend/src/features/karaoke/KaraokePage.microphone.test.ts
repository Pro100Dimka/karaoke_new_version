import { describe, expect, it } from "vitest";
import { microphoneAvailableForKaraoke, sceneVideoUrl } from "./KaraokePage";

describe("KaraokePage microphone availability", () => {
  it("keeps a participant's live pitch visible after device enumeration transiently reports missing", () => {
    expect(microphoneAvailableForKaraoke("missing", 440)).toBe(true);
    expect(microphoneAvailableForKaraoke("missing", undefined)).toBe(false);
  });

  it("uses the transferred room clip instead of a participant's unrelated local scene", () => {
    expect(
      sceneVideoUrl(
        "RoomPrepared",
        "scene://local/clip-07.webm",
        "http://local/song/clip",
      ),
    ).toBe("http://local/song/clip");
    expect(
      sceneVideoUrl(
        "Normal",
        "scene://local/clip-07.webm",
        "http://local/song/clip",
      ),
    ).toBe("scene://local/clip-07.webm");
  });
});
