import {
  reportOperationFailure,
  clearOperationFailure,
} from '../../shared/errors';
import type {
  KaraokeAudioPort,
  KaraokeRecordingPort,
} from '../../application/karaoke/KaraokePorts';

/** Releases every live karaoke audio path before the route disappears. */
export const releaseKaraokeAudio = async (
  audioClient: Pick<KaraokeAudioPort, 'setMonitoring' | 'setMixer' | 'stop'>,
  recordingCoordinator: Pick<KaraokeRecordingPort, 'stop'>,
): Promise<void> => {
  // Queue the old route's audio commands now; saving its recording may outlive the next route.
  const results = await Promise.allSettled([
    recordingCoordinator.stop(),
    audioClient.setMonitoring(false),
    // The master control belongs to karaoke; radio and previews elsewhere play at full level.
    audioClient.setMixer('master', 1),
    audioClient.stop(),
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    reportOperationFailure(
      'errors.finishPerformance',
      new AggregateError(failures.map((result) => result.reason)),
    );
  else clearOperationFailure('errors.finishPerformance');
};
