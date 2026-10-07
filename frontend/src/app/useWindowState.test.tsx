import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useWindowState } from "./useWindowState";

const desktop = vi.hoisted(() => ({
  isMaximized: vi.fn<() => Promise<boolean>>(),
  isFullscreen: vi.fn<() => Promise<boolean>>(),
  onWindowState: vi.fn<(listener: (state: WindowState) => void) => () => void>(),
}));

vi.mock("../services/desktopClient", () => ({ desktopClient: desktop }));

beforeEach(() => vi.clearAllMocks());

it("keeps the latest window event when the initial state request finishes later", async () => {
  let resolveMaximized: (value: boolean) => void = () => {};
  let resolveFullscreen: (value: boolean) => void = () => {};
  let emitWindowState: (state: WindowState) => void = () => {};
  desktop.isMaximized.mockReturnValue(
    new Promise((resolve) => {
      resolveMaximized = resolve;
    }),
  );
  desktop.isFullscreen.mockReturnValue(
    new Promise((resolve) => {
      resolveFullscreen = resolve;
    }),
  );
  desktop.onWindowState.mockImplementation((listener) => {
    emitWindowState = listener;
    return () => {};
  });

  const { result } = renderHook(useWindowState);
  act(() => emitWindowState({ maximized: true, fullscreen: true, minimized: false }));
  await act(async () => {
    resolveMaximized(false);
    resolveFullscreen(false);
  });

  expect(result.current).toEqual({
    maximized: true,
    fullscreen: true,
    minimized: false,
  });
});
