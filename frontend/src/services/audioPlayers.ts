import type { AudioServiceClient } from '../contracts/clients';
import type { PlaybackSnapshot } from '../contracts/models';
import { observeAudioTelemetry } from './audioSession';
import { parseKeyValues } from './audioProtocol';

/** What the radio and the recording preview need from the audio client they belong to. */
export interface AudioPlayerOperations {
  command(name: string, args?: Record<string, unknown>): Promise<string>;
  diagnostics(playbackOnly?: boolean): Promise<Record<string, string>>;
  ensureSession(): Promise<void>;
  snapshot(state: PlaybackSnapshot['state']): Promise<PlaybackSnapshot>;
  pythonRequest: DesktopApi['pythonRequest'];
  sampleRate(): Promise<number>;
}

type AudioPlayers = Pick<
  AudioServiceClient,
  | 'loadRadio'
  | 'playRadio'
  | 'pauseRadio'
  | 'stopRadio'
  | 'setRadioGain'
  | 'playRecording'
  | 'playSongPreview'
  | 'pauseRecordingPreview'
  | 'seekRecordingPreview'
  | 'stopRecordingPreview'
  | 'setPreviewVolume'
  | 'recordingPreviewStatus'
  | 'observeRecordingPreview'
>;

// PlaybackState numbers AudioService reports for the radio and the recording preview slots.
const readyState = 2;
const playingState = 3;
const pausedState = 4;
const finishedState = 6;
const failedState = 7;
const previewStates: Record<
  number,
  'ready' | 'playing' | 'paused' | 'finished'
> = {
  [readyState]: 'ready',
  [playingState]: 'playing',
  [pausedState]: 'paused',
  [finishedState]: 'finished',
};
const pollAttempts = 100;
const previewPollMilliseconds = 25;
const radioPollMilliseconds = 100;
const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

/** The two players outside karaoke: the internet radio and the preview of a saved recording. */
export const createAudioPlayers = (
  ops: AudioPlayerOperations,
): AudioPlayers => {
  let radioGeneration = 0;
  let previewRecordingId: string | null = null;
  let previewOwner: symbol | undefined;
  let loadingOwner: symbol | undefined;
  let pendingGain:
    { owner: symbol | undefined; value: number | undefined } | undefined;
  let previewKind: 'recording' | 'song' = 'recording';
  let previewServiceInstanceId: string | undefined;
  let previewGeneration = 0;
  const ownsPreview = (owner?: symbol) =>
    owner === undefined || owner === previewOwner;
  const previewStatus = (values: Record<string, string>, owner?: symbol) => {
    const sampleRate =
      Number(values.RuntimeOutputSampleRate || values.RequestedSampleRate) || 0;
    return {
      recordingId: ownsPreview(owner) ? previewRecordingId : null,
      state:
        previewStates[Number(values.PreviewState ?? readyState)] ?? 'ready',
      positionSeconds:
        sampleRate > 0
          ? (Number(values.PreviewPositionFrames) || 0) / sampleRate
          : 0,
    };
  };

  const waitFor = async (
    field: string,
    ready: readonly number[],
    interval: number,
    what: string,
    assertCurrent?: () => void,
  ) => {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      assertCurrent?.();
      const state = Number((await ops.diagnostics())[field] ?? 0);
      assertCurrent?.();
      if (state === failedState)
        throw new Error(`AudioService could not open the ${what}`);
      if (ready.includes(state)) return;
      await wait(interval);
    }
    throw new Error(`AudioService ${what} timed out`);
  };

  const playPreview = async (
    recordingId: string,
    owner: symbol | undefined,
    kind: 'recording' | 'song',
    gain?: number,
  ): Promise<PlaybackSnapshot> => {
    const generation = ++previewGeneration;
    const previousOwner = previewOwner;
    const previousRecordingId = previewRecordingId;
    loadingOwner = owner;
    const requestedGain = { owner, value: gain };
    pendingGain = requestedGain;
    try {
      const assertCurrent = () => {
        if (generation !== previewGeneration)
          throw new Error('Recording preview cancelled');
      };
      await ops.ensureSession();
      assertCurrent();
      const response = await ops.pythonRequest({
        method: 'GET',
        path: `/${kind === 'song' ? 'songs' : 'recordings'}/${encodeURIComponent(recordingId)}`,
      });
      assertCurrent();
      if (!response.ok || !response.body || typeof response.body !== 'object')
        throw new Error('Recording not found');
      const data = response.body as Record<string, unknown>;
      const { fileStatus } = data;
      const filePath = data[kind === 'song' ? 'sourcePath' : 'filePath'];
      if (['Preparing', 'PreparationFailed'].includes(String(fileStatus)))
        throw new Error('Recording preparation is not complete');
      if (typeof filePath !== 'string')
        throw new Error('Recording file path is invalid');
      const values = await ops.diagnostics();
      const state = Number(values.PreviewState ?? 0);
      assertCurrent();
      const loadRequired =
        previewRecordingId !== recordingId ||
        previewKind !== kind ||
        [0, finishedState, failedState].includes(state) ||
        (values.ServiceInstanceId !== undefined &&
          values.ServiceInstanceId !== previewServiceInstanceId);
      previewOwner = owner;
      if (loadRequired) {
        await ops.command('LoadRecordingPreview', { path: filePath });
        await waitFor(
          'PreviewState',
          [readyState, playingState, pausedState],
          previewPollMilliseconds,
          'recording',
          assertCurrent,
        );
        previewRecordingId = recordingId;
        previewKind = kind;
        previewServiceInstanceId = values.ServiceInstanceId;
      }
      // The volume control remains usable during loading. Apply its latest value before
      // starting playback, then let further changes go straight to the owned preview.
      assertCurrent();
      pendingGain = undefined;
      if (requestedGain.value !== undefined) {
        await ops.command('SetGain', {
          target: 'preview',
          value: requestedGain.value,
        });
        assertCurrent();
      }
      if (loadRequired || state !== playingState)
        await ops.command('PlayRecordingPreview');
      return ops.snapshot('playing');
    } catch (error) {
      if (
        generation === previewGeneration &&
        previewRecordingId === previousRecordingId
      )
        previewOwner = previousOwner;
      throw error;
    } finally {
      if (generation === previewGeneration) {
        loadingOwner = undefined;
        pendingGain = undefined;
      }
    }
  };

  const stopPreview: AudioPlayers['stopRecordingPreview'] = async (
    owner,
    recordingId,
  ) => {
    if (owner !== undefined && owner === loadingOwner && !ownsPreview(owner)) {
      previewGeneration += 1;
      loadingOwner = undefined;
      pendingGain = undefined;
      return;
    }
    if (recordingId !== undefined && previewRecordingId !== recordingId) return;
    if (!ownsPreview(owner)) return;
    previewGeneration += 1;
    previewOwner = undefined;
    loadingOwner = undefined;
    pendingGain = undefined;
    await ops.command('StopRecordingPreview');
    previewRecordingId = null;
  };

  return {
    async loadRadio(url) {
      await ops.ensureSession();
      await ops.command('LoadRadioStation', { url });
      await waitFor(
        'RadioState',
        [readyState],
        radioPollMilliseconds,
        'radio stream',
      );
    },
    async playRadio() {
      const generation = ++radioGeneration;
      await stopPreview();
      if (generation !== radioGeneration) return;
      await ops.command('PlayRadio');
    },
    async pauseRadio() {
      radioGeneration += 1;
      await ops.command('PauseRadio');
    },
    async stopRadio() {
      radioGeneration += 1;
      await ops.command('StopRadio');
    },
    async setRadioGain(gain) {
      await ops.command('SetRadioGain', { value: gain });
    },
    playRecording: (id, owner, gain) =>
      playPreview(id, owner, 'recording', gain),
    playSongPreview: (id, owner, gain) => playPreview(id, owner, 'song', gain),
    async pauseRecordingPreview(owner) {
      if (!ownsPreview(owner)) return;
      await ops.command('PauseRecordingPreview');
    },
    async seekRecordingPreview(positionSeconds, owner) {
      if (!ownsPreview(owner)) return;
      const generation = previewGeneration;
      const frame = Math.max(
        0,
        Math.round(positionSeconds * (await ops.sampleRate())),
      );
      if (generation !== previewGeneration || !ownsPreview(owner)) return;
      await ops.command('SeekRecordingPreview', { frame });
    },
    stopRecordingPreview: stopPreview,
    async setPreviewVolume(gain, owner) {
      if (pendingGain && pendingGain.owner === owner) {
        pendingGain.value = gain;
        return;
      }
      if (!ownsPreview(owner)) return;
      await ops.command('SetGain', { target: 'preview', value: gain });
    },
    async recordingPreviewStatus(owner) {
      return previewStatus(await ops.diagnostics(true), owner);
    },
    observeRecordingPreview(owner, onValue, onError) {
      return observeAudioTelemetry(
        'GetPlaybackSnapshot',
        16,
        (text) => onValue(previewStatus(parseKeyValues(text), owner)),
        onError,
      );
    },
  };
};
