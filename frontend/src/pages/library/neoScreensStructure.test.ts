import { describe, expect, it } from "vitest";

/** Sources of the screens rebuilt on Neo UI: the queue, the takes and the online room. */
const sources = import.meta.glob(
  [
    "./*.{tsx,css}",
    "./hero/*.tsx",
    "./songs/index.tsx",
    "./modals/{recordings,processing,analysis,add-song,song-settings}/*.{tsx,css}",
    "!./**/*.test.tsx",
    "../../features/room/RoomModal.tsx",
    "../../features/room/room-entry.css",
    "../../features/room/RoomDock.tsx",
    "../../features/room/RoomHeadCard.tsx",
    "../../features/room/RoomPersonCard.tsx",
    "../../features/room/RoomPersonMenu.tsx",
    "../../features/room/RoomLinkCard.tsx",
    "../../features/room/room-dock.css",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const read = (path: string) => sources[path] ?? "";

describe("library and room screens built on Neo UI", () => {
  it("take every control and icon from Neo UI", () => {
    for (const [path, text] of Object.entries(sources).filter(([path]) =>
      path.endsWith(".tsx"),
    )) {
      expect(text, path).toContain("@neo-ui-kit/react");
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
    expect(read("./modals/recordings/index.tsx")).toContain("<Planet");
    expect(read("./modals/recordings/index.tsx")).toContain("<PerformancesSignature");
    expect(read("./modals/recordings/RecordingCard.tsx")).toContain("performance-art.svg");
    expect(read("./modals/processing/index.tsx")).toContain("<NeonWaves");
    expect(read("../../features/room/RoomModal.tsx")).toContain("<NeonWaves");
    expect(read("../../features/room/RoomPersonCard.tsx")).toContain("<Avatar");
    expect(read("../../features/room/RoomLinkCard.tsx")).toContain("<SignalBars");
  });
});
