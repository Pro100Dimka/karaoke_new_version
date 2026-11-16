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

describe('recording preview ownership', () => {
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
            if (name === 'LoadRecordingPreview') throw new Error('Could not open recording');
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
      await players.playRecording('take', second);
      command.mockClear();

      await players.pauseRecordingPreview(first);
      await players.seekRecordingPreview(12, first);
      await players.stopRecordingPreview(first);

      expect(command).not.toHaveBeenCalled();
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
