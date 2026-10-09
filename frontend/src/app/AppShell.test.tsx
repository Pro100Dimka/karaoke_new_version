import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const settings = vi.hoisted(() => ({
  open: false,
  listeners: new Set<() => void>(),
  titleBarRenders: 0,
}));

vi.mock("./backdrop/QuantumFieldBackdrop", () => ({
  QuantumFieldBackdrop: ({ hidden }: { hidden?: boolean }) => (
    <div data-testid="spectrum-feed">
      {!hidden && <div data-testid="animated-backdrop" />}
    </div>
  ),
}));
vi.mock("./RadioContext", () => ({ RadioProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./AppContext", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
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
  it("does not mount the animated backdrop in Library", () => {
    renderRoute("/");
    expect(screen.queryByTestId("animated-backdrop")).not.toBeInTheDocument();
    expect(screen.getByTestId("spectrum-feed")).toBeInTheDocument();
  });

  it("keeps the existing backdrop outside Library", () => {
    renderRoute("/editor/42");
    expect(screen.getByTestId("animated-backdrop")).toBeInTheDocument();
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
