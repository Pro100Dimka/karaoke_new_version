import type {
  RecordingDto,
  SongLanguage,
} from '../../../contracts/models';
import type { MessageKey } from '../../../providers/localization/messages';

export const languageLabels = {
  Auto: 'languageAuto',
  Ukrainian: 'languageUkrainian',
  Russian: 'languageRussian',
  English: 'languageEnglish',
} as const satisfies Record<SongLanguage, MessageKey>;

const fileStatusKeys = {
  Preparing: 'recordingPreparing',
  PreparationFailed: 'recordingPreparationFailed',
  Ready: 'recordingFileReady',
  RecoveredIncomplete: 'recordingRecoveredIncomplete',
  Missing: 'recordingFileMissing',
  Failed: 'recordingFileFailed',
} as const;

const analysisStatusKeys = {
  NotAnalyzed: 'analysisNotAnalyzed',
  Queued: 'analysisQueued',
  Running: 'analysisRunning',
  Succeeded: 'analysisReady',
  Failed: 'analysisFailed',
  Stale: 'analysisStale',
} as const;

export const recordingStatusLabels = (
  fileStatus: NonNullable<RecordingDto['fileStatus']>,
  analysisStatus: NonNullable<RecordingDto['analysisStatus']>,
): readonly [MessageKey, MessageKey] => [
  fileStatusKeys[fileStatus],
  analysisStatusKeys[analysisStatus],
];
