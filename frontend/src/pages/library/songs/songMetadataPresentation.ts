import type { RecordingDto, SongLanguage } from '../../../contracts/models';

export const languageLabels = {
  Auto: 'languageAuto',
  Ukrainian: 'languageUkrainian',
  Russian: 'languageRussian',
  English: 'languageEnglish',
} as const satisfies Record<SongLanguage, string>;

const fileStatusKeys = {
  Preparing: 'recordingPreparing',
  PreparationFailed: 'recordingPreparationFailed',
  Ready: null,
  RecoveredIncomplete: 'recordingRecoveredIncomplete',
  Missing: null,
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
): readonly string[] => {
  const file = fileStatusKeys[fileStatus];
  const analysis = analysisStatusKeys[analysisStatus];
  return file ? [file, analysis] : [analysis];
};
