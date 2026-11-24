import { describe, expect, it, vi } from 'vitest';
import { createAudioPlayers, type AudioPlayerOperations } from './audioPlayers';
import { act, renderHook } from '@testing-library/react';
import { useRecordingPlayback } from '../pages/library/modals/recordings/useRecordingPlayback';

const preview = vi.hoisted(() => ({
  playRecording: vi.fn(),
  pauseRecordingPreview: vi.fn(),
  seekRecordingPreview: vi.fn(),
  stopRecordingPreview: vi.fn(),
  recordingPreviewStatus: vi.fn(),
  observeRecordingPreview: vi.fn(() => () => {}),
}));
vi.mock('./audioClient', () => ({ audioClient: preview }));

const setup = () => {
  const command = vi
    .fn<AudioPlayerOperations['command']>()
    .mockResolvedValue('');
  const pythonRequest = vi
    .fn<AudioPlayerOperations['pythonRequest']>()
    .mockResolvedValue({
      ok: true,
      status: 200,
      body: { filePath: 'test-recording.wav' },
    });
  const diagnostics = vi
    .fn<AudioPlayerOperations['diagnostics']>()
    .mockResolvedValue({
      PreviewState: '2',
      RuntimeOutputSampleRate: '48000',
      ServiceInstanceId: 'first',
    });
  const players = createAudioPlayers({
    command,
    pythonRequest,
    ensureSession: async () => undefined,
    diagnostics,
    sampleRate: async () => 48000,
    snapshot: async (state) => ({
      state,
      sessionId: 'test',
      positionSeconds: 0,
      durationSeconds: 60,
      recording: false,
      monitoring: false,
      inputLevel: 0,
    }),
  });
  return { players, command, pythonRequest, diagnostics };
};

it.each(['playRecording', 'playSongPreview'] as const)(
  'uses compact snapshots while %s is loading and keeps the initial service identity check',
  async (play) => {
    vi.useFakeTimers();
    try {
      const { players, diagnostics, pythonRequest, command } = setup();
      pythonRequest.mockResolvedValue({
        ok: true,
        status: 200,
        body: { filePath: 'take.wav', sourcePath: 'song.wav' },
      });
      diagnostics
        .mockResolvedValueOnce({
          PreviewState: '0',
          ServiceInstanceId: 'first',
        })
        .mockResolvedValueOnce({ PreviewState: '1' })
        .mockResolvedValueOnce({ PreviewState: '1' })
        .mockResolvedValueOnce({ PreviewState: '2' });
      const loading = players[play]('take', Symbol('preview'));
      await vi.runAllTimersAsync();
      await expect(loading).resolves.toMatchObject({ state: 'playing' });
      expect(
        diagnostics.mock.calls.map(([playbackOnly]) => playbackOnly),
      ).toEqual([undefined, true, true, true]);
      expect(command).toHaveBeenLastCalledWith('PlayRecordingPreview');
    } finally {
      vi.useRealTimers();
    }
  },
);

it('keeps radio loading on full diagnostics containing RadioState', async () => {
  vi.useFakeTimers();
  try {
    const { players, diagnostics } = setup();
    diagnostics
      .mockResolvedValueOnce({ RadioState: '1' })
      .mockResolvedValueOnce({ RadioState: '2' });
    const loading = players.loadRadio('https://radio.example.test/live');
    await vi.runAllTimersAsync();
    await loading;
    expect(diagnostics).toHaveBeenCalledTimes(2);
    expect(
      diagnostics.mock.calls.every(([playbackOnly]) => !playbackOnly),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

describe('radio transport intents', () => {
  it.each(['pauseRadio', 'stopRadio'] as const)(
    'does not start radio after a later %s while preview shutdown is pending',
    async (interrupt) => {
      const { players, command } = setup();
      let completePreviewStop!: (reply: string) => void;
      const pendingPreviewStop = new Promise<string>((resolve) => {
        completePreviewStop = resolve;
      });
      command.mockImplementation((name) =>
        name === 'StopRecordingPreview'
          ? pendingPreviewStop
          : Promise.resolve(''),
      );

      const starting = players.playRadio();
      await players[interrupt]();
      completePreviewStop('');
      await starting;

      expect(command.mock.calls.map(([name]) => name)).toEqual([
        'StopRecordingPreview',
        interrupt === 'pauseRadio' ? 'PauseRadio' : 'StopRadio',
      ]);
    },
  );

  it.each(['pauseRadio', 'stopRadio', 'playRadio'] as const)(
    'keeps the latest explicit Play after %s when an older preview stop completes',
    async (interrupt) => {
      const { players, command } = setup();
      let completePreviewStop!: (reply: string) => void;
      command.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            completePreviewStop = resolve;
          }),
      );

      const starting = players.playRadio();
      if (interrupt !== 'playRadio') await players[interrupt]();
      await players.playRadio();
      completePreviewStop('');
      await starting;

      expect(command.mock.calls.map(([name]) => name)).toEqual([
        'StopRecordingPreview',
        ...(interrupt === 'playRadio'
          ? []
          : [interrupt === 'pauseRadio' ? 'PauseRadio' : 'StopRadio']),
        'StopRecordingPreview',
        'PlayRadio',
      ]);
    },
  );
});

describe('recording preview ownership', () => {
  it.each(['lookup', 'native-load'])(
    'cancels a deleted recording while its %s is pending',
    async (stage) => {
      const { players, command, pythonRequest } = setup();
      const active = Symbol('active');
      await players.playRecording('active', active);
      command.mockClear();
      let finish!: () => void;
      if (stage === 'lookup')
        pythonRequest.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = () =>
                resolve({
                  ok: true,
                  status: 200,
                  body: { filePath: 'deleted.wav' },
                });
            }),
        );
      else
        command.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = () => resolve('');
            }),
        );
      const outcome = players.playRecording('deleted', Symbol('deleted')).then(
        () => 'played',
        () => 'cancelled',
      );
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await players.stopRecordingPreview(undefined, 'deleted');
      finish();

      expect(await outcome).toBe('cancelled');
      expect(command).not.toHaveBeenCalledWith('PlayRecordingPreview');
      expect(
        command.mock.calls.filter(([name]) => name === 'StopRecordingPreview'),
      ).toHaveLength(stage === 'lookup' ? 0 : 1);
      expect((await players.recordingPreviewStatus(active)).recordingId).toBe(
        stage === 'lookup' ? 'active' : null,
      );
    },
  );

  it('keeps a new preview selected when an older stop reply arrives late', async () => {
    const { players, command } = setup();
    const first = Symbol('first');
    const next = Symbol('next');
    await players.playRecording('first', first);
    let finish!: () => void;
    command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve('');
        }),
    );
    const stopping = players.stopRecordingPreview(first);
    await players.playRecording('next', next);
    finish();
    await stopping;

    expect((await players.recordingPreviewStatus(next)).recordingId).toBe(
      'next',
    );
    expect(
      (await players.recordingPreviewStatus(first)).recordingId,
    ).toBeNull();
  });

  it('lets another take finish loading when the previous take is deleted', async () => {
    const { players, pythonRequest } = setup();
    await players.playRecording('old', Symbol('old'));
    const next = Symbol('next');
    let finish!: () => void;
    pythonRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              status: 200,
              body: { filePath: 'next.wav' },
            });
        }),
    );
    const outcome = players.playRecording('next', next).then(
      () => 'played',
      () => 'cancelled',
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await players.stopRecordingPreview(undefined, 'old');
    finish();

    expect(await outcome).toBe('played');
    expect((await players.recordingPreviewStatus(next)).recordingId).toBe(
      'next',
    );
  });

  it('keeps a pending player volume separate from the active player and discards it on cancellation', async () => {
    const { players, command, pythonRequest } = setup();
    const active = Symbol('active');
    const pending = Symbol('pending');
    await players.playRecording('active', active, 0.5);
    let finish!: (
      reply: Awaited<ReturnType<AudioPlayerOperations['pythonRequest']>>,
    ) => void;
    pythonRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = players.playRecording('pending', pending, 1);
    const outcome = loading.catch(() => 'cancelled');
    await vi.waitFor(() => expect(pythonRequest).toHaveBeenCalledTimes(2));
    command.mockClear();
    await players.setPreviewVolume(0, pending);
    expect(command).not.toHaveBeenCalled();
    await players.setPreviewVolume(0.4, active);
    expect(command).toHaveBeenLastCalledWith('SetGain', {
      target: 'preview',
      value: 0.4,
    });
    await players.stopRecordingPreview(pending);
    command.mockClear();
    finish({ ok: true, status: 200, body: { filePath: 'pending.wav' } });
    expect(await outcome).toBe('cancelled');
    expect(command).not.toHaveBeenCalled();
    await players.playRecording('active', active, 0.6);
    expect(command.mock.calls.filter(([name]) => name === 'SetGain')).toEqual([
      ['SetGain', { target: 'preview', value: 0.6 }],
    ]);
  });

  it.each(['valid', 'missing', 'preparing', 'native-failure'])(
    'hands over a playing take only to a valid replacement (%s)',
    async (replacement) => {
      const { players, command, diagnostics, pythonRequest } = setup();
      const first = Symbol('first');
      await players.playRecording('take', first);
      diagnostics.mockResolvedValue({
        PreviewState: '3',
        RuntimeOutputSampleRate: '48000',
      });
      command.mockImplementation(async (name) => {
        if (name === 'PlayRecordingPreview')
          throw new Error('Playback is not prepared');
        return '';
      });
      const second = Symbol('second');
      if (replacement !== 'valid') {
        if (replacement === 'native-failure') {
          command.mockImplementation(async (name) => {
            if (name === 'LoadRecordingPreview')
              throw new Error('Could not open recording');
            return '';
          });
        } else {
          pythonRequest.mockResolvedValue({
            ok: replacement === 'preparing',
            status: replacement === 'preparing' ? 200 : 404,
            body: { filePath: 'other.wav', fileStatus: 'Preparing' },
          });
        }
        await expect(players.playRecording('other', second)).rejects.toThrow();
        expect((await players.recordingPreviewStatus(first)).recordingId).toBe(
          'take',
        );
        expect(
          (await players.recordingPreviewStatus(second)).recordingId,
        ).toBeNull();
        command.mockClear();
        await players.pauseRecordingPreview(first);
        expect(command).toHaveBeenCalledWith('PauseRecordingPreview');
        return;
      }

      await expect(
        players.playRecording('take', second),
      ).resolves.toMatchObject({
        state: 'playing',
      });
      expect(
        command.mock.calls.filter(([name]) => name === 'PlayRecordingPreview'),
      ).toHaveLength(1);
      expect((await players.recordingPreviewStatus(second)).recordingId).toBe(
        'take',
      );
      command.mockResolvedValue('');
      pythonRequest.mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          filePath: 'test-recording.wav',
          sourcePath: 'original-song.mp3',
        },
      });
      await players.playSongPreview('take', Symbol('original'));
      expect(pythonRequest).toHaveBeenLastCalledWith({
        method: 'GET',
        path: '/songs/take',
      });
      expect(command).toHaveBeenCalledWith('LoadRecordingPreview', {
        path: 'original-song.mp3',
      });
      expect(
        (await players.recordingPreviewStatus(second)).recordingId,
      ).toBeNull();
      command.mockClear();
      await players.playRadio();
      expect(command.mock.calls.map(([name]) => name)).toEqual([
        'StopRecordingPreview',
        'PlayRadio',
      ]);
      expect((await players.recordingPreviewStatus()).recordingId).toBeNull();
    },
  );
  it.each(['service', 'paused-player'])(
    'preserves ownership when another player replaces a take (%s)',
    async (layer) => {
      const { players, command } = setup();
      if (layer === 'paused-player') {
        preview.playRecording.mockImplementation(players.playRecording);
        preview.pauseRecordingPreview.mockImplementation(
          players.pauseRecordingPreview,
        );
        preview.seekRecordingPreview.mockImplementation(
          players.seekRecordingPreview,
        );
        preview.stopRecordingPreview.mockImplementation(
          players.stopRecordingPreview,
        );
        preview.recordingPreviewStatus.mockImplementation(
          players.recordingPreviewStatus,
        );
        const player = renderHook(() => useRecordingPlayback({ id: 'take' }));
        try {
          await act(() => player.result.current.toggle());
          await act(() => player.result.current.toggle());
          await players.playRecording('other', Symbol('other'));
          command.mockClear();
          await act(() => player.result.current.seek(20));
          expect(player.result.current.position).toBe(20);
          await act(() => player.result.current.toggle());
          expect(command).toHaveBeenCalledWith('SeekRecordingPreview', {
            frame: 960000,
          });
        } finally {
          player.unmount();
        }
        return;
      }
      const first = Symbol('first');
      const second = Symbol('second');
      await players.playRecording('take', first);
      await players.pauseRecordingPreview(first);
      await players.playRecording('take', second, 0.3);
      expect(command.mock.calls.slice(-2)).toEqual([
        ['SetGain', { target: 'preview', value: 0.3 }],
        ['PlayRecordingPreview'],
      ]);
      command.mockClear();

      await players.pauseRecordingPreview(first);
      await players.seekRecordingPreview(12, first);
      await players.stopRecordingPreview(first);
      await players.setPreviewVolume(0.1, first);

      expect(command).not.toHaveBeenCalled();
      await players.setPreviewVolume(0.4, second);
      expect(command).toHaveBeenLastCalledWith('SetGain', {
        target: 'preview',
        value: 0.4,
      });
      expect(
        (await players.recordingPreviewStatus(first)).recordingId,
      ).toBeNull();
      expect((await players.recordingPreviewStatus(second)).recordingId).toBe(
        'take',
      );
    },
  );

  it.each(['stop', 'replace', 'radio'])(
    'does not play an obsolete load after %s',
    async (operation) => {
      const { players, command, pythonRequest } = setup();
      const first = Symbol('first');
      const second = Symbol('second');
      let finish!: (
        reply: Awaited<ReturnType<AudioPlayerOperations['pythonRequest']>>,
      ) => void;
      pythonRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const loading = players.playRecording('first', first);
      const outcome = loading.then(
        () => 'played',
        () => 'cancelled',
      );
      await vi.waitFor(() => expect(pythonRequest).toHaveBeenCalledOnce());
      if (operation === 'stop') await players.stopRecordingPreview(first);
      else if (operation === 'radio') await players.playRadio();
      else await players.playRecording('second', second);
      command.mockClear();
      finish({ ok: true, status: 200, body: { filePath: 'first.wav' } });

      expect(await outcome).toBe('cancelled');
      expect(command).not.toHaveBeenCalled();
    },
  );
});

it.each(['stopped', 'empty', 'failed', 'restarted'])(
  'reloads a recording when the preview is %s',
  async (state) => {
    const { players, command, diagnostics } = setup();
    await players.playRecording('take');
    if (state === 'stopped') {
      await players.stopRecordingPreview();
      expect((await players.recordingPreviewStatus()).recordingId).toBeNull();
    } else {
      diagnostics.mockResolvedValue({
        PreviewState: state === 'empty' ? '0' : state === 'failed' ? '7' : '2',
        ServiceInstanceId: state === 'restarted' ? 'second' : 'first',
      });
      command.mockImplementation(async (name) => {
        if (name === 'LoadRecordingPreview')
          diagnostics.mockResolvedValue({
            PreviewState: '2',
            ServiceInstanceId: 'second',
          });
        return '';
      });
    }
    await players.playRecording('take');
    expect(
      command.mock.calls.filter(([name]) => name === 'LoadRecordingPreview'),
    ).toHaveLength(2);
  },
);
