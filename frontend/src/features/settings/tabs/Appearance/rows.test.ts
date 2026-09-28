import { describe, expect, it, vi } from "vitest";
import getRows from "./rows";

describe("appearance settings rows", () => {
  it("persists the selected theme as a preferences patch", () => {
    const updatePreferences = vi.fn();
    const rows = getRows(
      ((key: string) => key) as never,
      { enabled: false, stationId: "", volume: 0, setStation: vi.fn(), setVolume: vi.fn(), toggle: vi.fn() } as never,
      updatePreferences,
    );

    const themeRow = rows.find(row => row.tag === "theme") as { onSave?: (value: string) => void } | undefined;
    themeRow?.onSave?.("dark");

    expect(updatePreferences).toHaveBeenCalledWith({ theme: "dark" });
  });
});
