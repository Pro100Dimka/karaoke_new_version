import { act, render, screen } from "@testing-library/react";
import { QuantumBackground, type QuantumBackgroundProps } from "@neo-ui-kit/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { useSpectrumFeed } from "./backdrop/useSpectrumFeed";
import { desktopClient } from "../services/desktopClient";

const settings = vi.hoisted(() => ({
  open: false,
  listeners: new Set<() => void>(),
  titleBarRenders: 0,
  reducedMotion: false,
  onScreen: true,
}));

vi.mock("@neo-ui-kit/react", () => ({
  QuantumBackground: vi.fn(({ spectrum: _spectrum, spectrumRange: _range, fieldSize: _size, interactive: _interactive, ...props }: QuantumBackgroundProps) => (
    <div {...props} data-testid="quantum-background" />
  )),
  quantumBackgroundFullscreenFieldSize: 1.1,
}));
vi.mock("../services/desktopClient", () => {
  const window = { fullscreen: false };
  return {
    desktopClient: {
      toggleFullscreen: vi.fn(async () => (window.fullscreen = !window.fullscreen)),
      isFullscreen: vi.fn(async () => window.fullscreen),
      keepDisplayAwake: vi.fn(async (awake: boolean) => awake),
    },
  };
});
vi.mock("../services/inputLevel", () => ({ microphoneLevel: vi.fn(async () => 0) }));
vi.mock("./useAppOnScreen", () => ({ useAppOnScreen: () => settings.onScreen }));
vi.mock("./backdrop/useSpectrumFeed", () => ({ useSpectrumFeed: vi.fn() }));
vi.mock("./RadioContext", () => ({ RadioProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./AppContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useApp: () => ({ preferences: { reducedMotion: settings.reducedMotion } }),
    useSettingsDialog: () => ({
      settingsOpen: useSyncExternalStore(
        (listener) => {
          settings.listeners.add(listener);
          return () => settings.listeners.delete(listener);
        },
        () => settings.open,
      ),
    }),
  };
});
vi.mock("./TitleBar", () => ({ TitleBar: () => {
  settings.titleBarRenders += 1;
  return null;
} }));
vi.mock("./FloatingControls", () => ({ FloatingControls: () => null }));
vi.mock("./desktop/DesktopShellBridge", () => ({ DesktopShellBridge: () => null }));
vi.mock("./AppCloseFlow", () => ({ AppCloseFlow: () => null }));
vi.mock("./StartupRecovery", () => ({ StartupRecovery: () => null }));
vi.mock("./ServiceBanner", () => ({ ServiceBanner: () => null }));
vi.mock("../features/room/RoomDock", () => ({ RoomDock: () => null }));
vi.mock("../features/room/RoomSync", () => ({ RoomSync: () => null }));
vi.mock("../features/settings", () => ({ default: () => null }));

const renderRoute = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path={path} element={<div>Page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );

describe("AppShell backdrop", () => {
  it("shows QuantumBackground behind the Library, edge to edge and fed with AudioService's spectrum", () => {
    renderRoute("/");
    expect(screen.getByTestId("quantum-background")).toHaveClass("libraryBackdrop");
    expect(vi.mocked(QuantumBackground).mock.lastCall?.[0]).toMatchObject({
      interactive: false,
      fieldSize: 1.1,
      spectrumRange: [40, 12000],
      inert: true,
    });
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(true, expect.any(Function));
  });

  it("keeps the backdrop off outside the Library", () => {
    renderRoute("/karaoke/song");
    expect(screen.queryByTestId("quantum-background")).not.toBeInTheDocument();
  });

  it.each(["reducedMotion", "onScreen"] as const)("removes the backdrop and stops the spectrum feed when %s disables motion", (key) => {
    settings[key] = key === "reducedMotion";
    renderRoute("/");
    expect(screen.queryByTestId("quantum-background")).not.toBeInTheDocument();
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(false, expect.any(Function));
    settings.reducedMotion = false;
    settings.onScreen = true;
  });

  it.each(["reducedMotion", "onScreen"] as const)("stops the spectrum feed when %s disables motion", (key) => {
    settings[key] = key === "reducedMotion";
    renderRoute("/");
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(false, expect.any(Function));
    settings.reducedMotion = false;
    settings.onScreen = true;
  });

  it("pauses the covered route without a page-wide motion restyle", () => {
    const view = renderRoute("/");
    const titleBarRenders = settings.titleBarRenders;
    act(() => {
      settings.open = true;
      settings.listeners.forEach((listener) => listener());
    });
    expect(settings.titleBarRenders).toBe(titleBarRenders);
    const route = view.container.querySelector(".routeSurface");
    expect(route).toHaveAttribute("data-ad-offscreen");
    expect(route).not.toHaveAttribute("data-ad-motion");
    // Under Settings the scene stays mounted (re-creating it would recompile its WebGL shaders);
    // the stylesheet hides it and the spectrum stops, so it draws nothing.
    expect(screen.getByTestId("quantum-background")).toBeInTheDocument();
    expect(vi.mocked(QuantumBackground).mock.lastCall?.[0].spectrum).toBeUndefined();
    act(() => {
      settings.open = false;
      settings.listeners.forEach((listener) => listener());
    });
    expect(route).not.toHaveAttribute("data-ad-offscreen");
    view.unmount();
  });
});

describe("AppShell full screen", () => {
  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>Library</div>} />
            <Route path="/karaoke/:id" element={<div>Karaoke</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

  it("leaves Karaoke's F11 full screen when Karaoke closes", async () => {
    const view = renderAt("/karaoke/song");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11" })); });
    await settle();
    expect(await desktopClient.isFullscreen()).toBe(true);
    view.unmount();
    await settle();
    expect(await desktopClient.isFullscreen()).toBe(false);
  });

  it("keeps a full screen chosen from the title bar after Karaoke closes", async () => {
    await desktopClient.toggleFullscreen();
    const view = renderAt("/karaoke/song");
    view.unmount();
    await settle();
    expect(await desktopClient.isFullscreen()).toBe(true);
    await desktopClient.toggleFullscreen();
  });
});

describe("AppShell screen saver", () => {
  it("keeps the display awake only while Karaoke is open", () => {
    const awake = vi.mocked(desktopClient.keepDisplayAwake);
    awake.mockClear();
    const library = render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>Library</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(awake).not.toHaveBeenCalled();
    library.unmount();
    const karaoke = render(
      <MemoryRouter initialEntries={["/karaoke/song"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/karaoke/:id" element={<div>Karaoke</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(awake).toHaveBeenLastCalledWith(true);
    karaoke.unmount();
    expect(awake).toHaveBeenLastCalledWith(false);
  });
});
