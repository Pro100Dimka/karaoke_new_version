import { desktopBridge } from './desktopBridge';
import { measureAcousticLatency } from './acousticLatency';
import type {
  AudioServiceClient,
  PlaybackSchedule,
} from '../contracts/clients';
import {
  unverifiedAsioMonitoring,
  type PlaybackSnapshot,
  type RequestedAudioConfiguration,
} from '../contracts/models';
import {
  audioCapabilitiesFromValues,
  backendName,
  diagnosticNumber,
  parseKeyValues,
  runtimeConfigurationFromDiagnostics,
} from './audioProtocol';
import { createAudioPlayers } from './audioPlayers';
import type { MediaCheckpoint } from './audioReconfiguration';
import { mixerGain } from './mixerLevel';
import {
  audioClock,
  audioState,
  command,
  currentSampleRate,
  diagnostics,
  endpointArgs,
  endpointsAvailable,
  effectiveConfiguration,
  enqueueAudioOperation,
  ensureSession,
  onLowLatencyMicrophoneFallback,
  rawDevices,
  refreshClock,
  reportMicrophoneMode,
  snapshot,
  observeAudioTelemetry,
  observeSnapshots,
  waitForReady,
  waitForAudioOperations,
} from './audioSession';
import {
  isAsio4AllRoute,
  safeAudioConfiguration,
} from '../shared/preferences/preferences';
import { createRoomVoice, restoreVoiceSession } from './audioRoomVoice';
import { recordingCoordinator } from './recordingCoordinator';
export { invalidateAudioSnapshots } from './audioSession';

// The session in which a manual measurement was accepted; the server rejects stale contexts.
let calibrationContext = '';
// What AudioService was already told per device path, so unchanged values are not resent.
const rememberedLatencies = new Map<string, number>();
let healthySession: { process: string; native: string; reported: string } | undefined;
const healthIdentity = (values: Record<string, string>, controlled = false) => {
  const process = values.ServiceInstanceId;
  if (!process) return undefined;
  const native = [process, values.generationId].filter(Boolean).join(':');
  const reported = controlled && healthySession?.process === process
    ? healthySession.reported
    : healthySession?.native === native ? healthySession.reported : native;
  healthySession = { process, native, reported };
  return reported;
};

const restoreMediaSession = (checkpoint: MediaCheckpoint | null) =>
  audioState.reconfiguration.restore(
    checkpoint,
    audioState.dspParameters,
    audioState.dspEnabled,
    audioState.monitoringRequested,
    {
      ensureSession,
      resolveArtifacts: (song) =>
        desktopBridge().resolveProjectArtifacts(song.id, song.activeRevision),
      command,
      waitForReady,
      sampleRate: currentSampleRate,
      play: async (schedule) =>
        command('Play', schedule ? await scheduledStart(schedule) : undefined),
    },
  );

/** Switches AudioService to a configuration and brings back the room voice and the loaded song. */
const activateConfiguration = async (
  configuration: RequestedAudioConfiguration,
  checkpoint: MediaCheckpoint | null,
  format?: { sampleRate: number; channels: number },
): Promise<void> => {
  await command('Reconfigure', {
    ...endpointArgs(format ? { ...configuration, sampleRate: format.sampleRate } : configuration,
      0, format?.channels ?? 0),
    ...(format && { preserveRecording: true }),
  });
  audioState.active = configuration;
  if ((await diagnostics()).SessionState === 'Prepared') await command('StartSession');
  if (configuration.lowLatencyInput)
    await reportMicrophoneMode().catch(() => undefined);
  await restoreVoiceSession();
  await restoreMediaSession(checkpoint);
  healthIdentity(await diagnostics(), true);
};

const applyConfiguration = async (configuration: RequestedAudioConfiguration) => {
  const devices = await rawDevices();
  configuration = safeAudioConfiguration(configuration, devices);
  if (!endpointsAvailable(devices, configuration))
    throw new Error(`${configuration.backend} device is unavailable`);
  const previous = audioState.active;
  const previousPreferred = audioState.preferred;
  const checkpoint = await audioState.reconfiguration.checkpoint(snapshot);
  await recordingCoordinator.reconfigure(async (format) => {
    audioState.preferred = configuration;
    try {
      await activateConfiguration(effectiveConfiguration(configuration), checkpoint, format);
    } catch (error) {
      audioState.preferred = previousPreferred;
      await activateConfiguration(previous, checkpoint, format);
      throw error;
    }
  }, async () => (await snapshot()).positionSeconds);
  return runtimeConfigurationFromDiagnostics(await diagnostics());
};

const reconcileWindowsMode = async (): Promise<void> => {
  if (audioState.preferred.backend !== 'WASAPI Shared') return;
  const running = (await diagnostics()).Backend;
  if (effectiveConfiguration().backend !==
    (running === undefined ? audioState.active.backend : backendName(running)))
    await applyConfiguration(audioState.preferred);
};

/** Where AudioService starts a scheduled song: its clock ticks and the first frame. */
const scheduledStart = async (
  schedule: PlaybackSchedule,
): Promise<AudioBridgeRequest['args']> => {
  const values = await diagnostics();
  await refreshClock();
  const clock = audioClock();
  const sampleRate = Number(values.RuntimeOutputSampleRate);
  if (
    !Number.isFinite(Number(values.MonotonicTicks)) ||
    !clock ||
    !Number.isFinite(schedule.startAtMilliseconds) ||
    !(sampleRate > 0)
  )
    throw new Error('AudioService playback clock is unavailable');
  if (!Number.isFinite(schedule.positionSeconds))
    throw new Error('Invalid playback position');
  return {
    startAtTicks: Math.max(
      0,
      Math.round((schedule.startAtMilliseconds + clock.offset) * 1e6),
    ),
    frame: Math.max(0, Math.round(schedule.positionSeconds * sampleRate)),
  };
};

const parseBands = (value: string | undefined): number[] =>
  (value ?? '').split(',').map(Number).filter(Number.isFinite);
const spectrumFromText = (text: string) => {
  const values = parseKeyValues(text);
  return { bands: parseBands(values.bands), backingBands: parseBands(values.backingBands) };
};

export const audioClient: AudioServiceClient = {
  observeSnapshots,
  observeSpectrum(onValue, onError, intervalMs = 50) {
    return observeAudioTelemetry('GetSpectrum', intervalMs,
      text => onValue(spectrumFromText(text)), onError);
  },
  snapshot() {
    return enqueueAudioOperation(() => snapshot());
  },
  health() {
    return enqueueAudioOperation(async () => {
      try {
        const state = await command('GetServiceState');
        if (state !== 'Running') return { status: 'unavailable', version: '1' };
        let values = await diagnostics();
        // A replacement process is Running with an Idle session. A failed device also leaves the
        // control pipe alive. Reopen either before advertising usable audio; Suspended is deliberate.
        if (['Idle', 'Failed'].includes(values.SessionState ?? '')) {
          await ensureSession();
          values = await diagnostics();
        }
        return {
          status: 'ready',
          version: '1',
          instanceId: healthIdentity(values),
        };
      } catch {
        return { status: 'unavailable', version: '1' };
      }
    });
  },

  async listDevices() {
    return (await rawDevices()).map(
      ({ backendIndex: _backendIndex, ...device }) => device,
    );
  },

  async capabilities() {
    const devices = await this.listDevices();
    const hasMicrophone = devices.some(
      (device) => device.kind === 'input' && device.channels > 0,
    );
    return {
      microphone: hasMicrophone ? 'ready' : 'missing',
      keyboardLighting: false,
    };
  },

  async runtimeConfiguration() {
    return runtimeConfigurationFromDiagnostics(await diagnostics());
  },

  onLowLatencyMicrophoneFallback,

  setPreferredConfiguration(configuration) {
    audioState.preferred = configuration;
  },

  preferredConfiguration() {
    return { ...audioState.preferred };
  },

  async suspendSession() {
    await command('SuspendSession');
  },

  async resumeSession() {
    await command('ResumeSession');
  },

  async setAcousticLatency(milliseconds, context = calibrationContext) {
    await command('SetAcousticLatency', { ms: milliseconds, context });
  },

  async acousticCalibrationState() {
    const values = await diagnostics();
    const microseconds = Number(values.AcousticLatencyUs);
    const origins = ['NONE', 'PROFILE', 'TEST_SIGNAL', 'SONG'] as const;
    const origin =
      origins.find((name) => name === values.AcousticCalibrationOrigin) ??
      'NONE';
    return {
      fingerprint: values.AcousticCalibrationFingerprint ?? '',
      milliseconds:
        values.AcousticCalibrationValid === '1' && Number.isFinite(microseconds)
          ? microseconds / 1000
          : null,
      origin,
      songPlaying: values.PlaybackState === '3',
      songEstimates: Number(values.AcousticPassiveAccepted) || 0,
    };
  },

  async rememberAcousticLatencies(stored) {
    const values = await diagnostics();
    const open = values.AcousticCalibrationFingerprint;
    // A restarted AudioService forgot everything; its open path then reports no calibration.
    const forgotten = values.AcousticCalibrationValid !== '1';
    let restored = false;
    for (const [fingerprint, milliseconds] of Object.entries(stored)) {
      // Keys saved before fingerprints named no real device path and cannot be verified.
      if (!fingerprint.includes(',') || fingerprint.includes('|')) continue;
      if (
        rememberedLatencies.get(fingerprint) === milliseconds &&
        !(forgotten && fingerprint === open)
      )
        continue;
      const reply = await command('RememberAcousticLatency', {
        ms: milliseconds,
        fingerprint,
      });
      rememberedLatencies.set(fingerprint, milliseconds);
      restored ||= reply.trim() === 'AcousticLatencyRestored';
    }
    return restored;
  },

  async measureAcousticLatency() {
    await ensureSession();
    const measured = await measureAcousticLatency((name) => command(name));
    await command('SetAcousticLatency', {
      ms: measured.milliseconds,
      context: measured.context,
    });
    calibrationContext = measured.context;
    // Remembered at once: a device path reopened right after the measurement keeps it.
    if (measured.fingerprint) {
      await command('RememberAcousticLatency', {
        ms: measured.milliseconds,
        fingerprint: measured.fingerprint,
      });
      rememberedLatencies.set(measured.fingerprint, measured.milliseconds);
    }
    return {
      milliseconds: measured.milliseconds,
      fingerprint: measured.fingerprint,
    };
  },

  applyConfiguration(configuration) {
    const requested = { ...configuration };
    return enqueueAudioOperation(() => applyConfiguration(requested));
  },

  async openBackendControlPanel(configuration) {
    await command('OpenBackendControlPanel', endpointArgs(configuration));
  },

  async configurationCapabilities(configuration) {
    await waitForAudioOperations();
    const values = parseKeyValues(
      await command('GetAudioCapabilities', endpointArgs(configuration)),
    );
    return audioCapabilitiesFromValues(values, configuration.backend);
  },

  async spectrum() {
    return spectrumFromText(await command('GetSpectrum'));
  },

  diagnosticsDump: diagnostics,

  async testInputLevel() {
    await ensureSession();
    const values = parseKeyValues(await command('GetInputLevel'));
    return diagnosticNumber(values.rms ?? values.peak);
  },

  async playTestSound() {
    await ensureSession();
    await command('PlayOutputTest');
  },

  prepareSong(song, isCurrent = () => true) {
    return enqueueAudioOperation(async () => {
      if (!isCurrent()) throw new DOMException('Song preparation cancelled', 'AbortError');
      await ensureSession();
      if (!isCurrent()) throw new DOMException('Song preparation cancelled', 'AbortError');
      const artifacts = await desktopBridge().resolveProjectArtifacts(
        song.id,
        song.activeRevision,
      );
      if (!isCurrent()) throw new DOMException('Song preparation cancelled', 'AbortError');
      await command('LoadSong', {
        instrumental: artifacts.instrumental,
        vocals: artifacts.vocals,
        melody: artifacts.melody,
      });
      try {
        await waitForReady(isCurrent);
        if (!isCurrent()) throw new DOMException('Song preparation cancelled', 'AbortError');
      } catch (error) {
        if (!isCurrent()) await command('UnloadSong');
        throw error;
      }
      audioState.durationSeconds = song.durationSeconds;
      audioState.reconfiguration.song = song;
      audioState.reconfiguration.schedule = undefined;
      audioState.sessionId = crypto.randomUUID();
      return snapshot('ready');
    });
  },

  play(schedule) {
    return enqueueAudioOperation(async () => {
      await command(
        'Play',
        schedule ? await scheduledStart(schedule) : undefined,
      );
      audioState.reconfiguration.schedule = schedule;
      return snapshot('playing');
    });
  },

  pause() {
    return enqueueAudioOperation(async () => {
      await command('Pause');
      audioState.reconfiguration.schedule = undefined;
      return snapshot('paused');
    });
  },

  seek(positionSeconds, isCurrent = () => true) {
    return enqueueAudioOperation(async () => {
      if (!isCurrent()) throw new DOMException('Seek cancelled', 'AbortError');
      const runtime = await this.runtimeConfiguration();
      if (!isCurrent()) throw new DOMException('Seek cancelled', 'AbortError');
      await command('Seek', {
        frame: Math.max(0, Math.round(positionSeconds * runtime.sampleRate)),
      });
      audioState.reconfiguration.schedule = undefined;
      return snapshot();
    });
  },

  stop() {
    return enqueueAudioOperation(async () => {
      await command('Stop');
      // A stopped song stays loaded otherwise, and its open files keep Windows from deleting or moving it.
      audioState.reconfiguration.song = null;
      audioState.reconfiguration.schedule = undefined;
      await command('UnloadSong');
      return snapshot('finished');
    });
  },

  setMonitoring(enabled) {
    return enqueueAudioOperation(async () => {
      let cautious = false;
      if (
        enabled &&
        audioState.active.backend === 'ASIO' &&
        isAsio4AllRoute(audioState.active, await rawDevices())
      ) {
        const values = await diagnostics();
        cautious = Object.entries(values).some(([key, name]) => {
          if (
            !key.startsWith('AsioInputChannelName.') ||
            !/\bmic(rophone)?\b/i.test(name)
          )
            return false;
          const channel = key.slice('AsioInputChannelName.'.length);
          return Number(values[`AsioInputChannelRms.${channel}`]) > 0.00001;
        });
        if (!cautious) throw new Error(unverifiedAsioMonitoring);
      }
      const previous = audioState.monitoringRequested;
      audioState.monitoringRequested = enabled;
      try {
        await reconcileWindowsMode();
        if (enabled) {
          for (const [name, value] of audioState.dspParameters)
            await command('SetDspParameter', { name, value });
          await command('SetDspEnabled', { enabled: audioState.dspEnabled });
        }
        await command(
          'SetMonitoring',
          cautious ? { enabled, safety: 'asio4all' } : { enabled },
        );
        audioState.monitoring = enabled;
        return snapshot();
      } catch (error) {
        audioState.monitoringRequested = previous;
        await reconcileWindowsMode();
        throw error;
      }
    });
  },

  async setMixer(channel, position) {
    const gain = mixerGain(channel, position);
    audioState.reconfiguration.mixerGains.set(channel, gain);
    await command('SetGain', { target: channel, value: gain });
  },

  monitoringEnabled: () => audioState.monitoring,
  microphoneEnabled: () => audioState.microphoneEnabled,

  async setMicrophoneEnabled(enabled) {
    await command('SetMicrophoneEnabled', { enabled });
    audioState.microphoneEnabled = enabled;
  },

  ...createRoomVoice(applyConfiguration, reconcileWindowsMode),

  setPlaybackRate(rate, isCurrent = () => true) {
    return enqueueAudioOperation(async () => {
      if (!isCurrent()) return;
      await command('SetPlaybackRate', { value: rate });
      if (isCurrent()) audioState.reconfiguration.playbackRate = rate;
    });
  },

  setPitchShift(semitones, isCurrent = () => true) {
    return enqueueAudioOperation(async () => {
      if (!isCurrent()) return;
      await command('SetTranspose', { semitones });
      if (isCurrent()) audioState.reconfiguration.pitchShift = semitones;
    });
  },

  async setDspParameter(name, value) {
    audioState.dspParameters.set(name, value);
    await command('SetDspParameter', { name, value });
  },

  async setDspEnabled(enabled) {
    audioState.dspEnabled = enabled;
    await command('SetDspEnabled', { enabled });
  },

  ...createAudioPlayers({
    command,
    diagnostics,
    ensureSession,
    snapshot,
    pythonRequest: (request) => desktopBridge().pythonRequest(request),
    sampleRate: currentSampleRate,
  }),
};

export const getAudioSnapshot = (): Promise<PlaybackSnapshot> => snapshot();

// The automated Electron room test must exercise this exact production lifecycle rather than
// reconstructing join/rejoin calls in Playwright. The hook is absent from ordinary app sessions.
if (window.desktop?.roomE2e)
  window.roomE2eReconnectVoiceSession = () =>
    audioClient.reconnectVoiceSession();
