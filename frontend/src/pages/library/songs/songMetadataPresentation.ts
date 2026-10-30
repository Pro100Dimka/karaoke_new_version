import type { RecordingDto, SongDto, SongLanguage } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";

export const languageLabels = {
  Auto: "languageAuto", Ukrainian: "languageUkrainian", Russian: "languageRussian", English: "languageEnglish",
} as const satisfies Record<SongLanguage, MessageKey>;

export const detectedSongMetadata = (
  song: Pick<SongDto, "detectedBpm" | "detectedKey">,
): { bpm: string; key: string } => ({
  bpm:
    song.detectedBpm === undefined ? "—" : `${song.detectedBpm.toFixed(1)} BPM`,
  key: song.detectedKey || "—",
});

const fileStatusKeys = {
  Preparing: "recordingPreparing",
  PreparationFailed: "recordingPreparationFailed",
  Ready: "recordingFileReady",
  RecoveredIncomplete: "recordingRecoveredIncomplete",
  Missing: "recordingFileMissing",
  Failed: "recordingFileFailed",
} as const;

const analysisStatusKeys = {
  NotAnalyzed: "analysisNotAnalyzed",
  Queued: "analysisQueued",
  Running: "analysisRunning",
  Succeeded: "analysisReady",
  Failed: "analysisFailed",
  Stale: "analysisStale",
} as const;

export const recordingStatusLabels = (
  fileStatus: NonNullable<RecordingDto["fileStatus"]>,
  analysisStatus: NonNullable<RecordingDto["analysisStatus"]>,
): readonly [MessageKey, MessageKey] => [
  fileStatusKeys[fileStatus],
  analysisStatusKeys[analysisStatus],
];
