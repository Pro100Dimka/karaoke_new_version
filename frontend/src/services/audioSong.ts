import type { AudioServiceClient } from '../contracts/clients';
import type { MediaCheckpoint } from './audioReconfiguration';
import { desktopBridge } from './desktopBridge';
import {
  audioState,
  command,
  currentSampleRate,
  enqueueAudioOperation,
  ensureSession,
  snapshot,
  waitForReady,
} from './audioSession';

const restoreEditedPlayback = async (
  checkpoint: MediaCheckpoint | null,
  isCurrent: () => boolean,
): Promise<void> => {
  if (!checkpoint) return;
  await command('SetPlaybackRate', {
    value: audioState.reconfiguration.playbackRate,
  });
  await command('SetTranspose', {
    semitones: audioState.reconfiguration.pitchShift,
  });
  const sampleRate = await currentSampleRate();
  if (!isCurrent())
    throw new DOMException('Song preparation cancelled', 'AbortError');
  await command('Seek', {
    frame: Math.max(0, Math.round(checkpoint.positionSeconds * sampleRate)),
  });
  if (checkpoint.state === 'playing' && isCurrent()) await command('Play');
};

export const prepareSong: AudioServiceClient['prepareSong'] = (
  song,
  isCurrent = () => true,
  options = {},
) => {
  return enqueueAudioOperation(async () => {
    if (!isCurrent())
      throw new DOMException('Song preparation cancelled', 'AbortError');
    await ensureSession();
    if (!isCurrent())
      throw new DOMException('Song preparation cancelled', 'AbortError');
    const artifacts = await desktopBridge().resolveProjectArtifacts(
      song.id,
      song.activeRevision,
    );
    if (!isCurrent())
      throw new DOMException('Song preparation cancelled', 'AbortError');
    const checkpoint =
      options.preservePlayback &&
      audioState.reconfiguration.song?.id === song.id
        ? await audioState.reconfiguration.checkpoint(snapshot)
        : null;
    if (!isCurrent())
      throw new DOMException('Song preparation cancelled', 'AbortError');
    await command('LoadSong', {
      instrumental: artifacts.instrumental,
      vocals: artifacts.vocals,
      melody: artifacts.melody,
    });
    try {
      await waitForReady(isCurrent);
      if (!isCurrent())
        throw new DOMException('Song preparation cancelled', 'AbortError');
      await restoreEditedPlayback(checkpoint, isCurrent);
      if (!isCurrent())
        throw new DOMException('Song preparation cancelled', 'AbortError');
    } catch (error) {
      if (!isCurrent()) await command('UnloadSong');
      throw error;
    }
    audioState.durationSeconds = song.durationSeconds;
    audioState.reconfiguration.song = song;
    audioState.reconfiguration.schedule = undefined;
    audioState.sessionId = crypto.randomUUID();
    // A newly loaded source is idle; preserving pause must never issue Play just to pause again.
    if (checkpoint?.state === 'paused') return snapshot('paused');
    return snapshot(checkpoint?.state === 'playing' ? 'playing' : 'ready');
  });
};
