// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OpenRgbKeyboardLighting, parseOpenRgbKeyboards } from "../../electron/KeyboardLighting";

const listing = `0: Mainboard\n  Type: Motherboard\n1: K70 RGB\n  Type: Keyboard\n2: Mouse\n  Type: Mouse\n`;

describe("OpenRGB keyboard lighting provider", () => {
  it("selects keyboard controllers only", () => {
    expect(parseOpenRgbKeyboards(listing)).toEqual([{ index: 1, name: "K70 RGB" }]);
  });

  it("reports and controls an available local keyboard provider", async () => {
    const run = vi.fn(async (args: readonly string[]) => args.includes("--list-devices") ? listing : "");
    const provider = new OpenRgbKeyboardLighting("C:/OpenRGB/OpenRGB.exe", run);

    await expect(provider.capabilities()).resolves.toEqual({
      available: true,
      provider: "OpenRGB",
      deviceCount: 1,
    });
    await provider.apply({ enabled: true, brightness: 55, color: "ff2040" });

    expect(run).toHaveBeenLastCalledWith([
      "--device", "1", "--mode", "direct", "--color", "FF2040", "--brightness", "55",
    ]);
  });
});
