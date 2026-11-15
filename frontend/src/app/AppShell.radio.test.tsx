import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useRouter } from '@neo-ui-kit/react';
import { runInAction } from 'mobx';
import { TestRouter } from '../test/QueryProvider';
import { store } from '../providers/store';
import { audioClient } from '../services/audioClient';
import { AppShell } from './AppShell';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../providers/notifications', () => ({ useNotify: () => notify }));
vi.mock('../providers/application', () => ({
  subscribeAudioFocus: () => () => undefined,
  roomSession: { getScope: () => null },
}));
vi.mock('../services/audioClient', () => ({
  audioClient: {
    stopRadio: vi.fn(async () => undefined),
    loadRadio: vi.fn(async () => undefined),
    playRadio: vi.fn(async () => undefined),
    pauseRadio: vi.fn(async () => undefined),
    setRadioGain: vi.fn(async () => undefined),
    diagnosticsDump: vi.fn(async () => ({ RadioState: '3' })),
  },
}));
vi.mock('../services/desktopClient', () => ({
  desktopClient: {
    keepDisplayAwake: vi.fn(async () => undefined),
    toggleFullscreen: vi.fn(async () => false),
    isFullscreen: vi.fn(async () => false),
  },
}));
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
vi.mock('./FloatingControls', () => ({
  FloatingControls: () => <button>Radio controls</button>,
}));

const Navigation = () => {
  const { navigate } = useRouter();
  return (
    <>
      {['/', '/help', '/karaoke/song', '/editor/song'].map((path) => (
        <button key={path} onClick={() => navigate(path)}>
          {path}
        </button>
      ))}
    </>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  runInAction(() => {
    store.online.room = null;
    store.radio.enabled = true;
    store.radio.libraryActive = false;
    store.radio.preparedKey = '';
    store.radio.prepareRequest = 0;
    store.updatePreferences({ radioStation: 'groove-salad' });
  });
});
afterEach(cleanup);

const openLibrary = async () => {
  render(
    <TestRouter>
      <AppShell>
        <Navigation />
      </AppShell>
    </TestRouter>,
  );
  await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalled());
  vi.mocked(audioClient.stopRadio).mockClear();
  vi.mocked(audioClient.loadRadio).mockClear();
  vi.mocked(audioClient.playRadio).mockClear();
};

it('keeps the radio controls and current stream through library, help and back', async () => {
  await openLibrary();
  fireEvent.click(screen.getByRole('button', { name: '/help' }));
  expect(screen.getByRole('button', { name: 'Radio controls' })).toBeVisible();
  expect(store.radio.libraryActive).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /^\/$/ }));
  expect(screen.getByRole('button', { name: 'Radio controls' })).toBeVisible();
  expect(audioClient.stopRadio).not.toHaveBeenCalled();
  expect(audioClient.loadRadio).not.toHaveBeenCalled();
  expect(audioClient.playRadio).not.toHaveBeenCalled();
});

it.each(['/karaoke/song', '/editor/song'])(
  'still releases radio playback on %s',
  async (path) => {
    await openLibrary();
    fireEvent.click(screen.getByRole('button', { name: path }));
    expect(
      screen.queryByRole('button', { name: 'Radio controls' }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(audioClient.stopRadio).toHaveBeenCalled());
  },
);
