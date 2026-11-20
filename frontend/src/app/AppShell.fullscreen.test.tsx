import { useRouter } from '@neo-ui-kit/react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TestRouter } from '../test/QueryProvider';
import { routes } from '../shared/routes';
import { AppShell } from './AppShell';

const desktop = vi.hoisted(() => ({
  fullscreen: false,
  keepDisplayAwake: vi.fn(async () => undefined),
  toggleFullscreen: vi.fn<() => Promise<boolean>>(),
  isFullscreen: vi.fn<() => Promise<boolean>>(),
}));
vi.mock('../services/desktopClient', () => ({ desktopClient: desktop }));
vi.mock('../providers/notifications', () => ({
  useNotify: () => () => undefined,
}));
vi.mock('../providers/application', () => ({
  subscribeAudioFocus: () => () => undefined,
  roomSession: { getScope: () => null },
}));
vi.mock('../providers/radio', () => ({
  subscribeRadio: () => () => undefined,
}));
// Exercise the real shell and router without starting audio, room sessions or WebGL.
vi.mock('../features/karaoke/KaraokeHost', () => ({
  KaraokeHost: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock('../features/karaoke/tv/karaokeTv', () => ({
  useKaraokeTv: () => null,
}));
vi.mock('../features/karaoke/tv/TvRemote', () => ({ TvRemote: () => null }));
vi.mock('../features/room/RoomDock', () => ({ RoomDock: () => null }));
vi.mock('../features/room/RoomSync', () => ({ RoomSync: () => null }));
vi.mock('../pages/library/modals/settings', () => ({ default: () => null }));
vi.mock('../pages/library/background', () => ({ LibraryBackdrop: () => null }));
vi.mock('./backdrop/useSpectrumFeed', () => ({
  useSpectrumFeed: () => undefined,
}));
vi.mock('./desktop/DesktopShellBridge', () => ({
  DesktopShellBridge: () => null,
}));
vi.mock('./TitleBar', () => ({ TitleBar: () => null }));
vi.mock('./AppCloseFlow', () => ({ AppCloseFlow: () => null }));
vi.mock('./StartupRecovery', () => ({ StartupRecovery: () => null }));
vi.mock('./ServiceBanner', () => ({ ServiceBanner: () => null }));
vi.mock('./useAppOnScreen', () => ({ useAppOnScreen: () => true }));
vi.mock('./FloatingControls', () => ({ FloatingControls: () => null }));

const destinations = [routes.library, routes.help, routes.editor('song')];
const first = routes.karaoke('first');
const second = routes.karaoke('second');
const Navigation = () => {
  const { navigate, pathname } = useRouter();
  return (
    <>
      <output aria-label="Current route">{pathname}</output>
      {[second, ...destinations].map((path) => (
        <button key={path} onClick={() => navigate(path)}>
          {path}
        </button>
      ))}
    </>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  desktop.fullscreen = false;
  desktop.toggleFullscreen.mockImplementation(async () => {
    desktop.fullscreen = !desktop.fullscreen;
    return desktop.fullscreen;
  });
  desktop.isFullscreen.mockImplementation(async () => desktop.fullscreen);
});
afterEach(cleanup);

const openKaraoke = () =>
  render(
    <TestRouter initialEntries={[first]}>
      <AppShell>
        <Navigation />
      </AppShell>
    </TestRouter>,
  );
const navigate = async (path: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: path }));
  });
  expect(screen.getByLabelText('Current route')).toHaveTextContent(path);
};
const pressF11 = async () => {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'F11' });
  });
};

it.each(destinations)(
  'keeps F11 fullscreen between songs and releases it only when leaving Karaoke for %s',
  async (destination) => {
    openKaraoke();
    await pressF11();
    expect(desktop.fullscreen).toBe(true);
    expect(desktop.toggleFullscreen).toHaveBeenCalledOnce();

    // A normal playlist advances by navigating to the next song's Karaoke route.
    await navigate(second);
    expect(desktop.fullscreen).toBe(true);
    expect(desktop.toggleFullscreen).toHaveBeenCalledOnce();
    expect(desktop.isFullscreen).not.toHaveBeenCalled();

    await navigate(destination);
    expect(desktop.fullscreen).toBe(false);
    expect(desktop.toggleFullscreen).toHaveBeenCalledTimes(2);
    expect(desktop.isFullscreen).toHaveBeenCalledOnce();
  },
);

it.each(destinations)(
  'preserves fullscreen entered outside F11 when leaving Karaoke for %s',
  async (destination) => {
    desktop.fullscreen = true;
    openKaraoke();
    await navigate(second);
    await navigate(destination);
    await pressF11();

    expect(desktop.fullscreen).toBe(true);
    expect(desktop.toggleFullscreen).not.toHaveBeenCalled();
    expect(desktop.isFullscreen).not.toHaveBeenCalled();
  },
);

it('does not re-enter fullscreen on navigation after F11 has already turned it off', async () => {
  openKaraoke();
  await pressF11();
  await pressF11();
  expect(desktop.fullscreen).toBe(false);
  await navigate(second);
  await navigate(routes.library);
  expect(desktop.fullscreen).toBe(false);
  expect(desktop.toggleFullscreen).toHaveBeenCalledTimes(2);
  expect(desktop.isFullscreen).not.toHaveBeenCalled();
});
