import { vi } from 'vitest';
import type { SongDto } from '../src/contracts/models';

export const song = { id: 'song', activeRevision: 1 } as SongDto;
export const native = {
  sampleRate: 44100,
  channels: 1,
  durationFrames: 44100,
  startSessionFrame: 88200,
  stopSessionFrame: 132300,
  startPlaybackPosition: 22050,
  overrunCount: 1,
  gapMetadataDropped: 0,
  staleBlocks: 2,
  gaps: [{ startFrame: 90000, frameCount: 128 }],
};
export const responseText = (
  command: string,
  args?: AudioBridgeRequest['args'],
): string => {
  if (command === 'GetRecordingState' && !args?.details) return '5';
  const responses: Record<string, string> = {
    StopRecording: 'D:/take.wav',
    GetRecordingState: JSON.stringify(native),
  };
  return responses[command] ?? 'Ok';
};
export const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
export const setup = async () => {
  const inspectWave = vi.fn(async () => ({
    durationSeconds: 1,
    sampleRate: 44100,
    channels: 1,
  }));
  const audioRequest = vi.fn(async (request: AudioBridgeRequest) => ({
    status: 0,
    text: responseText(request.command, request.args),
  }));
  const pythonRequest = vi.fn(async (request: PythonBridgeRequest) => ({
    ok: true,
    status: 200,
    body:
      request.path === '/recordings/target'
        ? { recordingId: 'take', filePath: 'D:/take.wav' }
        : {},
  }));
  Object.assign(window, {
    desktop: {
      audioRequest,
      pythonRequest,
      inspectWave,
    },
  });
  const { recordingCoordinator } =
    await import('../src/services/recordingCoordinator');
  return { recordingCoordinator, audioRequest, pythonRequest, inspectWave };
};
