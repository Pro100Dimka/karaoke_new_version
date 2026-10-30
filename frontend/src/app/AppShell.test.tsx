import { useEffect } from "react";
import { subscribeCloseRequests, useCloseGuard } from "../providers/close-guards";
import { store } from "../providers/store";
import { act, render, screen } from "@testing-library/react";
import { QuantumBackground, type QuantumBackgroundProps } from "@neo-ui-kit/react";
import { TestRouter } from "../test/QueryProvider";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { useSpectrumFeed } from "./backdrop/useSpectrumFeed";
import { desktopClient } from "../services/desktopClient";

const settings = vi.hoisted(() => ({
  titleBarRenders: 0,
  onSettingsOpen: (_open: boolean) => {},
  reducedMotion: false,
  onScreen: true,
  onTv: false,
  localProcessing: false,
}));

vi.mock("@neo-ui-kit/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@neo-ui-kit/react")>(),
  QuantumBackground: vi.fn(({ spectrum: _spectrum, spectrumRange: _range, fieldSize: _size, interactive: _interactive, ...props }: QuantumBackgroundProps) => (
    <div {...props} data-testid="quantum-background" />
  )),
  quantumBackgroundFullscreenFieldSize: 1.1,
}));
vi.mock("../services/desktopClient", () => {
  const window = { fullscreen: false };
  return {
    desktopClient: {
      onCloseRequested: vi.fn(() => vi.fn()),
      confirmClose: vi.fn(async () => undefined),
      toggleFullscreen: vi.fn(async () => (window.fullscreen = !window.fullscreen)),
      isFullscreen: vi.fn(async () => window.fullscreen),
      keepDisplayAwake: vi.fn(async (awake: boolean) => awake),
    },
  };
});
vi.mock("../services/inputLevel", () => ({ microphoneLevel: vi.fn(async () => 0) }));
vi.mock("./useAppOnScreen", () => ({ useAppOnScreen: () => settings.onScreen }));
vi.mock("./backdrop/useSpectrumFeed", () => ({ useSpectrumFeed: vi.fn() }));
vi.mock("../providers/radio", () => ({ subscribeRadio: () => () => {} }));
vi.mock("../providers/application", () => ({
  subscribeAudioFocus: () => () => {},
  useApp: () => ({ preferences: { reducedMotion: settings.reducedMotion }, localProcessing: settings.localProcessing }),
}));
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
vi.mock("../pages/library/modals/settings", () => ({ default: ({ onOpenChange }: { onOpenChange(open: boolean): void }) => {
  settings.onSettingsOpen = onOpenChange;
  return null;
} }));
// Karaoke itself (KaraokeHost) is tested on its own; here only whether it is on the TV matters.
vi.mock("../features/karaoke/KaraokeHost", () => ({
  KaraokeHost: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../features/karaoke/tv/karaokeTv", () => ({
  useKaraokeTv: () => (settings.onTv ? { active: true } : null),
}));
vi.mock("../features/karaoke/tv/TvRemote", () => ({ TvRemote: () => <div data-testid="tv-remote" /> }));

const renderRoute = (path: string) =>
  render(
    <TestRouter initialEntries={[path]}>
      <AppShell><div>Page</div></AppShell>
    </TestRouter>,
  );

describe("AppShell backdrop", () => {
  it("releases the WebGL backdrop and spectrum polling while local processing is active", () => {
    store.application.localProcessing = true;
    const view = renderRoute("/");
    expect(screen.queryByTestId("quantum-background")).not.toBeInTheDocument();
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(
      false,
      expect.any(Function),
      50,
    );
    store.application.localProcessing = false;
    view.rerender(
      <TestRouter>
        <AppShell />
      </TestRouter>,
    );
    expect(screen.getByTestId("quantum-background")).toBeInTheDocument();
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(
      true,
      expect.any(Function),
      50,
    );
    view.unmount();
  });

  it("shows QuantumBackground behind the Library, edge to edge and fed with AudioService's spectrum", () => {
    renderRoute("/");
    expect(screen.getByTestId("quantum-background").parentElement).toHaveStyle({
      position: "absolute", inset: "0", pointerEvents: "none",
    });
    expect(vi.mocked(QuantumBackground).mock.lastCall?.[0]).toMatchObject({
      fieldSize: 1.05,
      spectrumRange: [40, 12000],
    });
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(true, expect.any(Function), 50);
  });

  it("keeps the backdrop off outside the Library", () => {
    renderRoute("/karaoke/song");
    expect(screen.queryByTestId("quantum-background")).not.toBeInTheDocument();
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(true, expect.any(Function), 1000 / 60);
  });

  it.each(["reducedMotion", "onScreen"] as const)("removes the backdrop and stops the spectrum feed when %s disables motion", (key) => {
    settings[key] = key === "reducedMotion";
    store.updatePreferences({ reducedMotion: settings.reducedMotion });
    renderRoute("/");
    expect(screen.queryByTestId("quantum-background")).not.toBeInTheDocument();
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(false, expect.any(Function), 50);
    settings.reducedMotion = false;
    store.updatePreferences({ reducedMotion: false });
    settings.onScreen = true;
  });

  it.each(["reducedMotion", "onScreen"] as const)("stops the spectrum feed when %s disables motion", (key) => {
    settings[key] = key === "reducedMotion";
    store.updatePreferences({ reducedMotion: settings.reducedMotion });
    renderRoute("/");
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(false, expect.any(Function), 50);
    settings.reducedMotion = false;
    store.updatePreferences({ reducedMotion: false });
    settings.onScreen = true;
  });

  it("pauses the covered route without a page-wide motion restyle", () => {
    const view = renderRoute("/");
    const titleBarRenders = settings.titleBarRenders;
    act(() => {
      settings.onSettingsOpen(true);
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
      settings.onSettingsOpen(false);
    });
    expect(route).not.toHaveAttribute("data-ad-offscreen");
    view.unmount();
  });
});

describe("AppShell full screen", () => {
  const renderAt = (path: string) =>
    render(
      <TestRouter initialEntries={[path]}>
        <AppShell><div>Page</div></AppShell>
      </TestRouter>,
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
      <TestRouter initialEntries={["/"]}>
        <AppShell><div>Page</div></AppShell>
      </TestRouter>,
    );
    expect(awake).not.toHaveBeenCalled();
    library.unmount();
    const karaoke = render(
      <TestRouter initialEntries={["/karaoke/song"]}>
        <AppShell><div>Page</div></AppShell>
      </TestRouter>,
    );
    expect(awake).toHaveBeenLastCalledWith(true);
    karaoke.unmount();
    expect(awake).toHaveBeenLastCalledWith(false);
  });

  it("rests the Library while Karaoke plays on the TV: no backdrop, the screen on, the TV remote shown", () => {
    const awake = vi.mocked(desktopClient.keepDisplayAwake);
    awake.mockClear();
    settings.onTv = true;
    try {
      renderRoute("/");
      expect(screen.queryByTestId("quantum-background")).toBeNull();
      expect(screen.getByTestId("tv-remote")).toBeInTheDocument();
      expect(awake).toHaveBeenLastCalledWith(true);
    } finally {
      settings.onTv = false;
    }
  });
});

it("subscribes close guards directly and uses the latest guard without a provider", async () => {
  let close!: () => void;
  const unsubscribe = vi.fn();
  vi.mocked(desktopClient.onCloseRequested).mockImplementation(callback => {
    close = callback;
    return unsubscribe;
  });
  const Probe = ({ allowed }: { allowed: boolean }) => {
    useCloseGuard(async () => allowed);
    useEffect(subscribeCloseRequests, []);
    return null;
  };
  const view = render(<Probe allowed={false} />);
  await act(async () => { close(); });
  expect(desktopClient.confirmClose).toHaveBeenLastCalledWith(false);
  view.rerender(<Probe allowed />);
  await act(async () => { close(); });
  expect(desktopClient.confirmClose).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("does not reopen an old performance analysis after leaving the library", () => {
  store.returnFromKaraoke({ analysisSongId: "song", analysisFor: "take", performanceReturn: true });
  try {
    const view = renderRoute("/help");
    expect(store.playback.returned).toBeNull();
    view.unmount();
  } finally { store.returnFromKaraoke(null); }
});
