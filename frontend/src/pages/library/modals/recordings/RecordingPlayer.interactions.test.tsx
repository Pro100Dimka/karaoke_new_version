import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RecordingDto } from '../../../../contracts/models';
import {
  createAudioPlayers,
  type AudioPlayerOperations,
} from '../../../../services/audioPlayers';
import { RecordingPlayer } from './RecordingPlayer';

// Exercise the actual player, hook, volume knob and preview service together.
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  tr: (key: string) => key,
}));
const audio = vi.hoisted(() => ({
  client: {} as ReturnType<typeof createAudioPlayers>,
}));
vi.mock('../../../../services/audioClient', () => ({
  audioClient: audio.client,
}));
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: {} }));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../../shared/hooks/useWaveformPeaks', () => ({
  useRecordingPeaks: () => [],
}));
vi.mock('../../../../shared/errors', () => ({
  clearOperationFailure: vi.fn(),
  reportOperationFailure: vi.fn(),
  observeOperation: (_key: string, promise: Promise<unknown>) => promise,
}));

const recording: RecordingDto = {
  id: 'take',
  songId: 'song',
  filePath: 'take.wav',
  displayName: '',
  createdAt: '',
  durationSeconds: 10,
  sizeBytes: 100,
  analyzed: false,
};

beforeEach(() => vi.clearAllMocks());

it.each(['metadata', 'native-ready'] as const)(
  'starts muted when the visible knob is muted while waiting for %s',
  async (stage) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaded = false;
    let waiting = false;
    const command = vi
      .fn<AudioPlayerOperations['command']>()
      .mockImplementation(async (name) => {
        if (name === 'LoadRecordingPreview') loaded = true;
        return '';
      });
    const pythonRequest = vi
      .fn<AudioPlayerOperations['pythonRequest']>()
      .mockImplementation(async () => {
        if (stage === 'metadata') {
          waiting = true;
          await pending;
        }
        return { ok: true, status: 200, body: { filePath: 'take.wav' } };
      });
    const diagnostics = vi
      .fn<AudioPlayerOperations['diagnostics']>()
      .mockImplementation(async () => {
        if (stage === 'native-ready' && loaded) {
          waiting = true;
          await pending;
        }
        return { PreviewState: '2', RuntimeOutputSampleRate: '48000' };
      });
    Object.assign(
      audio.client,
      createAudioPlayers({
        command,
        pythonRequest,
        diagnostics,
        ensureSession: async () => undefined,
        sampleRate: async () => 48000,
        snapshot: async (state) => ({
          state,
          sessionId: 'preview',
          positionSeconds: 0,
          durationSeconds: 10,
          recording: false,
          monitoring: false,
          inputLevel: 0,
        }),
      }),
      { observeRecordingPreview: vi.fn(() => () => {}) },
    );

    render(<RecordingPlayer recording={recording} />);
    fireEvent.click(screen.getByRole('button', { name: 'playRecording' }));
    await waitFor(() => expect(waiting).toBe(true));
    const knob = screen.getByRole('slider', { name: 'recordingVolume' });
    fireEvent.keyDown(knob, { key: 'Home' });
    expect(knob).toHaveAttribute('aria-valuenow', '0');
    await act(async () => {
      release();
    });
    await screen.findByRole('button', { name: 'pause' });

    const playback = command.mock.calls.findIndex(
      ([name]) => name === 'PlayRecordingPreview',
    );
    expect(playback).toBeGreaterThan(-1);
    const gainBeforePlaying = command.mock.calls
      .slice(0, playback)
      .filter(([name]) => name === 'SetGain')
      .at(-1);
    expect(gainBeforePlaying).toEqual([
      'SetGain',
      { target: 'preview', value: 0 },
    ]);
  },
);
