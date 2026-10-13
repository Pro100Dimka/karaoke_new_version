import { act, render, screen } from "@testing-library/react";
import { QuantumBackground, type QuantumBackgroundProps } from "@neo-ui-kit/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { useSpectrumFeed } from "./backdrop/useSpectrumFeed";

const settings = vi.hoisted(() => ({
  open: false,
  listeners: new Set<() => void>(),
  titleBarRenders: 0,
  reducedMotion: false,
  onScreen: true,
}));

vi.mock("@neo-ui-kit/react", () => ({
  QuantumBackground: vi.fn((props: QuantumBackgroundProps) => <div {...props} data-testid="quantum-background" />),
}));
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
  it("keeps QuantumBackground disabled while the spectrum feed still serves the song covers", () => {
    renderRoute("/");
    expect(QuantumBackground).not.toHaveBeenCalled();
    expect(screen.queryByTestId("quantum-background")).not.toBeInTheDocument();
    expect(useSpectrumFeed).toHaveBeenLastCalledWith(true, expect.any(Function));
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
    act(() => {
      settings.open = false;
      settings.listeners.forEach((listener) => listener());
    });
    expect(route).not.toHaveAttribute("data-ad-offscreen");
    view.unmount();
  });
});
