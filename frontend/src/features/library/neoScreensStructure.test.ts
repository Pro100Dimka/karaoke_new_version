import { describe, expect, it } from "vitest";

/** Sources of the screens rebuilt on Neo UI: the queue, the takes and the online room. */
const sources = import.meta.glob(
  [
    "./*.{tsx,css}",
    "!./*.test.tsx",
    "!./VirtualGrid.tsx",
    "../room/RoomModal.tsx",
    "../room/room-entry.css",
    "../room/RoomDock.tsx",
    "../room/RoomHeadCard.tsx",
    "../room/RoomPersonCard.tsx",
    "../room/RoomPersonMenu.tsx",
    "../room/RoomLinkCard.tsx",
    "../room/room-dock.css",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const read = (path: string) => sources[path] ?? "";

describe("library and room screens built on Neo UI", () => {
  it("take every control and icon from Neo UI", () => {
    for (const [path, text] of Object.entries(sources).filter(([path]) =>
      path.endsWith(".tsx"),
    )) {
      expect(text, path).toContain("@ad-voice/ui");
      expect(text, path).not.toContain("lucide-react");
      expect(text, path).not.toContain("theme/ui");
    }
  });

  it("size their layouts by content and screen, not by fixed pixels", () => {
    for (const [path, text] of Object.entries(sources).filter(([path]) =>
      path.endsWith(".css"),
    ))
      expect(text, path).not.toMatch(/\d+px/);
  });

  it("keep their scenery", () => {
    expect(read("./RecordingsModal.tsx")).toContain("<Planet");
    expect(read("./RecordingsModal.tsx")).toContain("<PerformancesSignature");
    expect(read("./RecordingCard.tsx")).toContain("performance-art.svg");
    expect(read("./ProcessingModal.tsx")).toContain("<NeonWaves");
    expect(read("../room/RoomModal.tsx")).toContain("<NeonWaves");
    expect(read("../room/RoomPersonCard.tsx")).toContain("<Avatar");
    expect(read("../room/RoomLinkCard.tsx")).toContain("<SignalBars");
  });
});
