import { subscribeAudioFocus } from './application';
import { QueryProvider } from '../test/QueryProvider';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  suspend: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  pendingTake: vi.fn(() => false),
}));
const desktop = vi.hoisted(() => ({
  listener: undefined as ((state: WindowState) => void) | undefined,
  focusListener: undefined as ((focused: boolean) => void) | undefined,
  onAppFocus: vi.fn((listener: (focused: boolean) => void) => {
    desktop.focusListener = listener;
    return () => {
      desktop.focusListener = undefined;
    };
  }),
  onWindowState: vi.fn((listener: (state: WindowState) => void) => {
    desktop.listener = listener;
    return () => {
      desktop.listener = undefined;
    };
  }),
}));

vi.mock('../services/audioClient', () => ({
  audioClient: {
    suspendSession: audio.suspend,
    resumeSession: audio.resume,
  },
}));
vi.mock('../services/recordingCoordinator', () => ({
  recordingCoordinator: { hasPendingTake: audio.pendingTake },
}));

vi.mock('../services/desktopClient', () => ({
  desktopClient: {
    setAppIcon: vi.fn(async () => undefined),
    onWindowState: desktop.onWindowState,
    onAppFocus: desktop.onAppFocus,
  },
}));

vi.mock('../shared/preferences/preferences', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../shared/preferences/preferences')>();
  return {
    ...actual,
    loadPreferences: () => ({
      ...actual.defaultPreferences(),
      audio: {
        backend: 'ASIO',
        sampleRate: 44100,
        periodFrames: 512,
        bufferFrames: 512,
      },
      releaseAsioInBackground: true,
    }),
    savePreferences: vi.fn(),
  };
});

const AudioFocus = ({ settingsOpen = false }: { settingsOpen?: boolean }) => {
  useEffect(() => subscribeAudioFocus(() => settingsOpen), [settingsOpen]);
  return null;
};

describe('ASIO background release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    audio.pendingTake.mockReset().mockReturnValue(false);
  });
  it('keeps an unfinished recording running after blur and minimize', async () => {
    audio.pendingTake.mockReturnValue(true);
    try {
      render(
        <QueryProvider application>
          <AudioFocus />
        </QueryProvider>,
      );
      await act(async () => {
        desktop.focusListener?.(false);
        desktop.listener?.({
          maximized: false,
          fullscreen: false,
          minimized: true,
        });
      });
      expect(audio.suspend).not.toHaveBeenCalled();
    } finally {
      audio.pendingTake.mockReturnValue(false);
    }
  });
  it('releases ASIO after the app loses focus and restores it on return', async () => {
    render(
      <QueryProvider application>
        <AudioFocus />
      </QueryProvider>,
    );

    act(() => desktop.focusListener?.(false));
    await waitFor(() => expect(audio.suspend).toHaveBeenCalledOnce());

    act(() => desktop.focusListener?.(true));
    await waitFor(() => expect(audio.resume).toHaveBeenCalledOnce());
  });

  it('releases ASIO when the window is minimized even while settings are open', async () => {
    render(
      <QueryProvider application>
        <AudioFocus settingsOpen />
      </QueryProvider>,
    );
    await waitFor(() => expect(desktop.listener).toBeTypeOf('function'));

    act(() =>
      desktop.listener?.({
        maximized: false,
        fullscreen: false,
        minimized: true,
      }),
    );
    act(() => desktop.focusListener?.(false));
    await waitFor(() => expect(audio.suspend).toHaveBeenCalled());
  });

  it('keeps ASIO active while a detached panel owns focus, including main-window minimize', async () => {
    render(
      <QueryProvider application>
        <AudioFocus />
      </QueryProvider>,
    );
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      desktop.focusListener?.(true);
      desktop.listener?.({
        maximized: false,
        fullscreen: false,
        minimized: true,
      });
    });
    expect(audio.suspend).not.toHaveBeenCalled();
  });

  it('cancels a queued release when focus returns before it starts', async () => {
    render(
      <QueryProvider application>
        <AudioFocus />
      </QueryProvider>,
    );
    await act(async () => {
      desktop.focusListener?.(false);
      desktop.focusListener?.(true);
    });
    expect(audio.suspend).not.toHaveBeenCalled();
    expect(audio.resume).not.toHaveBeenCalled();
  });

  it('rechecks recording ownership before executing a queued release', async () => {
    render(
      <QueryProvider application>
        <AudioFocus />
      </QueryProvider>,
    );
    try {
      await act(async () => {
        desktop.focusListener?.(false);
        audio.pendingTake.mockReturnValue(true);
      });
      await act(async () => {
        desktop.focusListener?.(true);
      });
      expect(audio.suspend).not.toHaveBeenCalled();
      expect(audio.resume).not.toHaveBeenCalled();
    } finally {
      audio.pendingTake.mockReturnValue(false);
    }
  });
});
