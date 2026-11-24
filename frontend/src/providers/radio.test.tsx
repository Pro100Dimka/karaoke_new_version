import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { audioClient } from '../services/audioClient';
import {
  changeRadioStation,
  setRadioStation,
  setYoutubePlaylist,
  subscribeRadio,
  toggleRadio,
} from './radio';
import { store } from './store';
import { runInAction } from 'mobx';
import { useEffect, useLayoutEffect } from 'react';
import type { RoomStateDto } from '../contracts/models';
import { clearOperationFailure, operationFailures } from '../shared/errors';

const appState = vi.hoisted(() => ({
  room: null as null | Record<string, unknown>,
  setRoom: vi.fn(),
  publishSharedState: vi.fn(async () => undefined),
  updatePreferences: vi.fn(),
  audioEpoch: 0,
  resolveYoutube: vi.fn(),
}));

vi.mock('../services/youtubeRadio', () => ({
  resolveYoutubeRadio: appState.resolveYoutube,
}));
vi.mock('../services/audioClient', () => ({
  audioClient: {
    loadRadio: vi.fn(async () => undefined),
    playRadio: vi.fn(async () => undefined),
    pauseRadio: vi.fn(async () => undefined),
    stopRadio: vi.fn(async () => undefined),
    setRadioGain: vi.fn(async () => undefined),
    diagnosticsDump: vi.fn(async () => ({ RadioState: '3' })),
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
  it('remembers the broadcast station and advancing YouTube position independently', () => {
    const playlistId = 'PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y';
    act(() => {
      setRadioStation('kiss-fm');
      setYoutubePlaylist(
        `https://youtube.com/playlist?list=${playlistId}&index=4`,
      );
      store.radio.enabled = false;
      changeRadioStation();
      setRadioStation('radio-jazz');
    });
    expect(store.preferences.radioYoutubePlaylist).toBe(
      `https://www.youtube.com/playlist?list=${playlistId}&index=5`,
    );
    expect(store.preferences.radioBroadcastStation).toBe('radio-jazz');
    expect(store.radio.enabled).toBe(false);
    act(() => setRadioStation(`youtube:${playlistId}:5`));
    expect(store.preferences.radioBroadcastStation).toBe('radio-jazz');
    expect(store.radio.enabled).toBe(false);
  });
  it('can skip an unavailable playlist item without retrying the same failed position', async () => {
    appState.resolveYoutube.mockImplementation(
      async (playlistId: string, index: number) => {
        if (index === 2) throw new Error('unavailable track');
        return {
          playlistId,
          playlistTitle: 'Playlist',
          index,
          count: 3,
          id: 'QUsg4kgvwBo',
          title: `Track ${index}`,
          artist: 'Artist',
          url: `https://audio.example/track-${index}`,
        };
      },
    );
    runInAction(() => {
      store.updatePreferences({
        radioStation: 'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:1',
      });
      store.radio.enabled = true;
    });
    render(<RadioConnection libraryActive />);
    await waitFor(() =>
      expect(audioClient.loadRadio).toHaveBeenCalledWith(
        'https://audio.example/track-1',
      ),
    );
    act(() => changeRadioStation());
    await waitFor(() => expect(store.radio.error).toBe(true));
    act(() => changeRadioStation());
    await waitFor(() =>
      expect(audioClient.loadRadio).toHaveBeenCalledWith(
        'https://audio.example/track-3',
      ),
    );
  });
  it('retains a YouTube playlist and track position as the selected source', () => {
    store.updatePreferences({
      radioStation: 'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:7',
    });
    expect(store.radio.stationId).toBe(
      'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:7',
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(audioClient.playRadio).mockResolvedValue(undefined);
    vi.mocked(audioClient.loadRadio).mockResolvedValue(undefined);
    appState.room = null;
    appState.audioEpoch = 0;
    appState.publishSharedState.mockResolvedValue(undefined);
    clearOperationFailure('errors.radioMetadata');
    vi.mocked(audioClient.diagnosticsDump).mockResolvedValue({
      RadioState: '3',
    });
    appState.resolveYoutube.mockImplementation(
      async (playlistId: string, index: number) => ({
        playlistId,
        playlistTitle: 'My playlist',
        index,
        count: 2,
        id: 'QUsg4kgvwBo',
        title: `Track ${index}`,
        artist: 'Artist',
        url: `https://audio.example/track-${index}`,
      }),
    );
    runInAction(() => {
      store.online.room = null;
      store.radio.enabled = false;
      store.radio.libraryActive = false;
      store.radio.preparedKey = '';
      store.radio.prepareRequest = 0;
      store.radio.youtubeTrack = null;
      store.radio.youtubeResolvedAt = 0;
      store.updatePreferences({
        radioStation: 'groove-salad',
        radioVolume: 35,
      });
    });
  });

  it.each([
    ['toggle', () => toggleRadio()],
    ['station change', () => setRadioStation('drone-zone')],
  ])(
    'reports a failed room radio %s so it can be retried',
    async (_, change) => {
      appState.room = {
        code: 'ROOM',
        role: 'participant',
        collaborativeControl: true,
        radioEnabled: false,
        radioStationId: 'groove-salad',
        libraryQuery: '',
        libraryStatus: 'all',
        librarySort: 'recent',
      };
      const error = new Error('Room connection lost');
      appState.publishSharedState.mockRejectedValueOnce(error);
      const failure = vi.fn();
      const unsubscribe = operationFailures.subscribe(failure);
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      try {
        render(<RadioConnection libraryActive={false} />);
        act(change);
        await waitFor(() =>
          expect(failure).toHaveBeenCalledWith({
            operation: 'errors.radioMetadata',
            error,
          }),
        );
        expect(store.radio.enabled).toBe(false);
        expect(store.radio.stationId).toBe('groove-salad');
        act(change);
        await waitFor(() =>
          expect(appState.publishSharedState).toHaveBeenCalledTimes(2),
        );
      } finally {
        unsubscribe();
        consoleError.mockRestore();
      }
    },
  );

  it('plays playlist tracks through the radio slot, advances at EOF and repeats the playlist', async () => {
    vi.useFakeTimers();
    try {
      runInAction(() => {
        store.updatePreferences({
          radioStation: 'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:1',
        });
        store.radio.enabled = true;
      });
      const view = render(<RadioConnection libraryActive />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(audioClient.loadRadio).toHaveBeenCalledWith(
        'https://audio.example/track-1',
      );
      vi.mocked(audioClient.diagnosticsDump).mockResolvedValueOnce({
        RadioState: '6',
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });
      expect(audioClient.loadRadio).toHaveBeenCalledWith(
        'https://audio.example/track-2',
      );
      vi.mocked(audioClient.diagnosticsDump).mockResolvedValueOnce({
        RadioState: '6',
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
      });
      expect(store.radio.stationId).toBe(
        'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:1',
      );
      expect(appState.resolveYoutube).toHaveBeenCalledTimes(3);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the shared source and leaves automatic track changes to the host', async () => {
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
    const view = render(<RadioConnection libraryActive />);
    await waitFor(() => expect(audioClient.loadRadio).toHaveBeenCalledTimes(1));
    act(() => {
      setYoutubePlaylist(
        'https://youtube.com/playlist?list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y',
      );
    });
    expect(appState.publishSharedState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        radioEnabled: true,
        radioStationId: 'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:1',
      }),
    );
    expect(audioClient.loadRadio).toHaveBeenCalledTimes(1);
    expect(appState.resolveYoutube).not.toHaveBeenCalled();
    appState.room = {
      ...appState.room,
      radioStationId: 'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:1',
    };
    view.rerender(<RadioConnection libraryActive />);
    await waitFor(() =>
      expect(audioClient.loadRadio).toHaveBeenCalledWith(
        'https://audio.example/track-1',
      ),
    );
    vi.mocked(audioClient.diagnosticsDump).mockResolvedValue({
      RadioState: '6',
    });
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(audioClient.diagnosticsDump).not.toHaveBeenCalled();
    expect(store.radio.stationId).toBe(
      'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:1',
    );
    view.unmount();
    vi.useRealTimers();
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

    await waitFor(() => expect(store.radio.enabled).toBe(true));
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
    await waitFor(() => expect(store.radio.enabled).toBe(true));

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

  it.each(['', 'secret-agent'])(
    'publishes a valid station when creating a room with preference %j',
    async (station) => {
      runInAction(() => store.updatePreferences({ radioStation: station }));
      const view = render(<RadioConnection libraryActive />);
      appState.room = {
        code: 'NEW-ROOM',
        role: 'host',
        radioEnabled: false,
        radioStationId: 'groove-salad',
      };
      view.rerender(<RadioConnection libraryActive />);
      await waitFor(() =>
        expect(appState.publishSharedState).toHaveBeenCalledWith(
          expect.objectContaining({
            radioEnabled: false,
            radioStationId: station || 'groove-salad',
          }),
        ),
      );
    },
  );

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
