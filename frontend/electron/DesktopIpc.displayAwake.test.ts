import { expect, it, vi } from "vitest";
import type { TrustedIpc } from "./TrustedIpc";

const blocker = vi.hoisted(() => ({ next: 1, active: new Set<number>(), start: vi.fn(), stop: vi.fn() }));
vi.mock("electron", () => ({
  app: {},
  clipboard: {},
  dialog: {},
  shell: {},
  screen: { getCursorScreenPoint: () => ({ x: 900, y: 300 }) },
  powerSaveBlocker: {
    start: blocker.start.mockImplementation((type: string) => {
      expect(type).toBe("prevent-display-sleep");
      const id = blocker.next++;
      blocker.active.add(id);
      return id;
    }),
    stop: blocker.stop.mockImplementation((id: number) => blocker.active.delete(id)),
  },
}));

it("restores and moves a fullscreen header drag using the real cursor and rejects invalid anchors", async () => {
  const { registerDesktopIpc } = await import("./DesktopIpc");
  const { ipcChannels } = await import("./ipcChannels");
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const current = { getNormalBounds: () => ({ width: 1000 }), setFullScreen: vi.fn(),
    isFullScreen: () => true, isMaximized: () => true, unmaximize: vi.fn(), setPosition: vi.fn() };
  registerDesktopIpc({
    trustedIpc: { handle: (channel: string, listener: never) => handlers.set(channel, listener) } as unknown as TrustedIpc,
    window: () => current as never, storageRoot: () => "", reveal: vi.fn(), confirmClose: vi.fn(),
  });
  const drag = (...args: unknown[]) => handlers.get(ipcChannels.dragWindow)!({}, ...args);
  drag("start", NaN, 10);
  expect(current.setPosition).not.toHaveBeenCalled();
  drag("start", 0.25, 12);
  expect(current.setFullScreen).toHaveBeenCalledWith(false);
  expect(current.unmaximize).toHaveBeenCalledOnce();
  expect(current.setPosition).toHaveBeenLastCalledWith(650, 288);
  drag("move");
  expect(current.setPosition).toHaveBeenCalledTimes(2);
  drag("end");
  drag("move");
  expect(current.setPosition).toHaveBeenCalledTimes(2);
});
vi.mock("./Asio4AllInstaller", () => ({ launchAsio4AllInstaller: vi.fn() }));
vi.mock("./AppPaths", () => ({ projectRoot: vi.fn(), saveStorageRoot: vi.fn(), themeIconPath: vi.fn() }));
vi.mock("./SceneProtocol", () => ({ pickSceneClip: vi.fn() }));
vi.mock("./Splash", () => ({ isThemeName: vi.fn(), saveTheme: vi.fn() }));

it("keeps one display blocker while Karaoke asks for it and releases it afterwards", async () => {
  const { registerDesktopIpc } = await import("./DesktopIpc");
  const { ipcChannels } = await import("./ipcChannels");
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerDesktopIpc({
    trustedIpc: { handle: (channel: string, listener: never) => handlers.set(channel, listener) } as unknown as TrustedIpc,
    window: () => null,
    storageRoot: () => "",
    reveal: vi.fn(),
    confirmClose: vi.fn(),
  });
  const awake = (value: unknown) => handlers.get(ipcChannels.keepDisplayAwake)!({}, value);

  expect(awake(true)).toBe(true);
  expect(awake(true)).toBe(true);
  expect(blocker.start).toHaveBeenCalledOnce();
  expect(blocker.active.size).toBe(1);

  expect(awake(false)).toBe(false);
  expect(blocker.active.size).toBe(0);
  expect(awake(false)).toBe(false);
  expect(blocker.stop).toHaveBeenCalledOnce();

  // Only an explicit `true` keeps the screen on; anything else from the renderer releases it.
  expect(awake(true)).toBe(true);
  expect(awake("yes")).toBe(false);
  expect(blocker.active.size).toBe(0);
});
