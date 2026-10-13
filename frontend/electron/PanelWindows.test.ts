import { expect, it, vi } from "vitest";

const displays = vi.hoisted(() => ({
  all: [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 3840, height: 2160 } },
  ],
}));
vi.mock("electron", () => ({
  screen: {
    getAllDisplays: () => displays.all,
    getPrimaryDisplay: () => displays.all[0],
    getDisplayMatching: (bounds: { x: number }) => (bounds.x >= 1920 ? displays.all[1] : displays.all[0]),
  },
}));

import { panelWindowOpenHandler, stageScreenDisplay, stageScreenWindowName } from "./PanelWindows";

it("puts the stage on the display the app is not on, else on the app's own", () => {
  expect(stageScreenDisplay(displays.all, 1)?.id).toBe(2);
  expect(stageScreenDisplay(displays.all, 2)?.id).toBe(1);
  expect(stageScreenDisplay([displays.all[0]!], 1)?.id).toBe(1);
});

it("opens the stage screen full screen and opaque on the other display; other panels stay as they were", () => {
  const handler = panelWindowOpenHandler(undefined, () => ({ x: 100, y: 100, width: 1200, height: 800 }));
  const stage = handler({ url: "about:blank", frameName: `${stageScreenWindowName}-3` } as never);
  expect(stage).toMatchObject({
    action: "allow",
    overrideBrowserWindowOptions: { x: 1920, y: 0, width: 3840, height: 2160, fullscreen: true, frame: false, backgroundColor: "#000000" },
  });
  const panel = handler({ url: "about:blank", frameName: "ad-voice-panel:console" } as never);
  expect(panel).toMatchObject({ action: "allow", overrideBrowserWindowOptions: { transparent: true, resizable: false } });
  expect(handler({ url: "https://evil.example", frameName: stageScreenWindowName } as never)).toEqual({ action: "deny" });
  expect(handler({ url: "about:blank", frameName: "other" } as never)).toEqual({ action: "deny" });
  // Only the numbered stage screen is full screen; a lookalike name is an ordinary panel.
  expect(handler({ url: "about:blank", frameName: `${stageScreenWindowName}x` } as never)).toMatchObject({ overrideBrowserWindowOptions: { transparent: true } });
});
