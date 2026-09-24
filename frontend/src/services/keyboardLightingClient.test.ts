import { describe, expect, it } from "vitest";
import { keyboardLightingColor } from "./keyboardLightingClient";

describe("keyboard lighting frames", () => {
  it("keeps theme mode stable and makes music mode follow the playback timeline", () => {
    expect(keyboardLightingColor("green", "theme", 0, 50)).toBe("35E39A");
    expect(keyboardLightingColor("green", "theme", 3, 50)).toBe("35E39A");
    expect(keyboardLightingColor("dark", "music", 0, 100))
      .not.toBe(keyboardLightingColor("dark", "music", 0.5, 100));
  });
});
