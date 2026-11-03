import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audioClient } from '../services/audioClient';
import { subscribeRadio, toggleRadio } from './radio';
import { store } from './store';
import { runInAction } from 'mobx';
import { useEffect, useLayoutEffect } from 'react';
import type { RoomStateDto } from '../contracts/models';

const appState = vi.hoisted(() => ({
  room: null as null | Record<string, unknown>,
  setRoom: vi.fn(),
  publishSharedState: vi.fn(async () => undefined),
  updatePreferences: vi.fn(),
  audioEpoch: 0,
}));

vi.mock('../services/audioClient', () => ({
  audioClient: {
    loadRadio: vi.fn(async () => undefined),
    playRadio: vi.fn(async () => undefined),
    pauseRadio: vi.fn(async () => undefined),
    stopRadio: vi.fn(async () => undefined),
    setRadioGain: vi.fn(async () => undefined),
  },
}));

vi.mock('./application', () => ({ roomSession: { getScope: () => ({}) } }));
vi.mock('../application/room/RoomLibraryCoordinator', () => ({
  RoomLibraryCoordinator: class {
    publishSharedState = appState.publishSharedState;
  },
}));
const notify = vi.fn();
const RadioConnection = ({ libraryActive }: { libraryActive: boolean }) => {
  useLayoutEffect(() => {
    runInAction(() => {
      store.online.room = appState.room as RoomStateDto | null;
      store.application.services.audioEpoch = appState.audioEpoch;
      store.radio.libraryActive = libraryActive;
    });
  }, [libraryActive, appState.room, appState.audioEpoch]);
  useEffect(() => subscribeRadio(notify), []);
  return null;
};

describe('RadioConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(audioClient.playRadio).mockResolvedValue(undefined);
    vi.mocked(audioClient.loadRadio).mockResolvedValue(undefined);
    appState.room = null;
    appState.audioEpoch = 0;
    runInAction(() => {
      store.online.room = null;
      store.radio.enabled = false;
      store.radio.libraryActive = false;
      store.radio.preparedKey = '';
      store.radio.prepareRequest = 0;
      store.updatePreferences({
        radioStation: 'groove-salad',
        radioVolume: 35,
      });
    });
  });

  it.each([false, true])(
    'reloads a forgotten radio station after an AudioService restart (enabled=%s)',
    async (enabled) => {
      const view = render(<RadioConnection libraryActive />);
      await waitFor(() =>
        expect(audioClient.loadRadio).toHaveBeenCalledTimes(1),
      );
      if (enabled) {
        act(() => toggleRadio());
        await waitFor(() =>
          expect(audioClient.playRadio).toHaveBeenCalledTimes(1),
        );
      }
      appState.audioEpoch = 1;
      view.rerender(<RadioConnection libraryActive />);
      await waitFor(() =>
        expect(audioClient.loadRadio).toHaveBeenCalledTimes(2),
      );
      if (!enabled) act(() => toggleRadio());
      await waitFor(() =>
        expect(audioClient.playRadio).toHaveBeenCalledTimes(enabled ? 2 : 1),
      );
    },
  );

  it('prepares the station once and reuses it for instant pause and resume', async () => {
    render(<RadioConnection libraryActive />);

    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(1));
    expect(audioClient.playRadio).not.toHaveBeenCalled();

    act(() => toggleRadio());
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(1));

    act(() => toggleRadio());
    await waitFor(() =>
      expect(audioClient.pauseRadio).toHaveBeenCalledTimes(1),
    );

    act(() => toggleRadio());
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(2));
    expect(audioClient.loadRadio).toHaveBeenCalledTimes(1);
  });

  it('pauses an in-flight play request when the radio is switched off', async () => {
    let finish!: () => void;
    vi.mocked(audioClient.playRadio).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<RadioConnection libraryActive />);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledOnce());
    act(() => toggleRadio());
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledOnce());
    act(() => toggleRadio());
    await act(async () => {
      finish();
    });

    expect(store.radio.enabled).toBe(false);
    expect(audioClient.pauseRadio).toHaveBeenCalledOnce();
  });

  it('does not disable a newer play request when an older play fails', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(audioClient.playRadio).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    render(<RadioConnection libraryActive />);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledOnce());
    act(() => toggleRadio());
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledOnce());
    act(() => toggleRadio());
    act(() => toggleRadio());
    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalledTimes(2));
    await act(async () => {
      fail(new Error('obsolete device request'));
    });

    expect(store.radio.enabled).toBe(true);
  });

  it('inherits the host radio state and publishes room toggles', async () => {
    appState.room = {
      code: 'ROOM',
      role: 'participant',
      collaborativeControl: true,
      radioEnabled: true,
      radioStationId: 'groove-salad',
      libraryQuery: '',
      libraryStatus: 'all',
      librarySort: 'recent',
    };
    render(<RadioConnection libraryActive />);

    await waitFor(() =>
      expect(store.radio.enabled).toBe(true),
    );
    act(() => toggleRadio());

    await waitFor(() =>
      expect(appState.publishSharedState).toHaveBeenCalledWith(
        expect.objectContaining({
          radioEnabled: false,
          radioStationId: 'groove-salad',
        }),
      ),
    );
  });

  it("publishes the host's current radio state when the host creates a room", async () => {
    const view = render(<RadioConnection libraryActive />);
    act(() => toggleRadio());
    await waitFor(() =>
      expect(store.radio.enabled).toBe(true),
    );

    appState.room = {
      code: 'NEW-ROOM',
      role: 'host',
      radioEnabled: false,
      radioStationId: 'groove-salad',
      libraryQuery: '',
      libraryStatus: 'all',
      librarySort: 'recent',
    };
    view.rerender(<RadioConnection libraryActive />);

    await waitFor(() =>
      expect(appState.publishSharedState).toHaveBeenCalledWith(
        expect.objectContaining({
          radioEnabled: true,
          radioStationId: 'groove-salad',
        }),
      ),
    );
  });

  it('keeps the authoritative room radio switch enabled when local playback fails', async () => {
    appState.room = {
      code: 'ROOM',
      role: 'participant',
      radioEnabled: true,
      radioStationId: 'groove-salad',
      libraryQuery: '',
      libraryStatus: 'all',
      librarySort: 'recent',
    };
    vi.mocked(audioClient.playRadio).mockRejectedValueOnce(
      new Error('device busy'),
    );

    render(<RadioConnection libraryActive />);

    await waitFor(() => expect(audioClient.playRadio).toHaveBeenCalled());
    expect(store.radio.enabled).toBe(true);
  });

  it('ignores an unfinished stream load after unsubscribe', async () => {
    let finish!: () => void;
    vi.mocked(audioClient.loadRadio).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    runInAction(() => {
      store.radio.enabled = true;
    });
    const view = render(<RadioConnection libraryActive />);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalled());
    view.unmount();
    const played = vi.mocked(audioClient.playRadio).mock.calls.length;
    await act(async () => {
      finish();
    });
    expect(audioClient.playRadio).toHaveBeenCalledTimes(played);
    expect(store.radio.preparedKey).toBe('');
    expect(audioClient.stopRadio).toHaveBeenCalled();
  });
});
