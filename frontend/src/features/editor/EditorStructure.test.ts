import { describe, expect, it } from "vitest";

const sources = import.meta.glob(["./*.{tsx,css}", "../../app/AppShell.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const source = (name: string) =>
  sources[name.startsWith(".") ? name : `./${name}`] ?? "";

describe("melody editor structure", () => {
  it("edits notes in the library piano roll and seeks on the real waveform", () => {
    const page = source("EditorPage.tsx");
    expect(page).toContain("<PianoRoll");
    expect(page).toContain("onNoteDrag={drag}");
    expect(page).toContain("onNoteDragEnd={dragEnd}");
    expect(source("EditorTransport.tsx")).toContain(
      "useWaveformPeaks(songId, revision)",
    );
  });

  it("lives under the shared title bar and puts its way back there", () => {
    expect(source("../../app/AppShell.tsx")).toContain("<TitleBar />");
    expect(source("EditorHeader.tsx")).toContain("createPortal(back, slot)");
  });

  it("keeps no fixed-size reference scene or drawn artwork", () => {
    const styles = source("editor.css");
    expect(styles).not.toMatch(/\d+px/);
    expect(styles).not.toContain("1280");
  });
});
