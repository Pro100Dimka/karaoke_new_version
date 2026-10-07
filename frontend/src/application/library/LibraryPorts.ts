import type { AudioServiceClient, DesktopClient, PythonClient } from "../../contracts/clients";

/** Capabilities used by the library; the composition root supplies their implementations. */
export type LibraryCatalogPort = Pick<PythonClient,
  "listSongs" | "importSong" | "processSong" | "cancelProcessing" |
  "updateSong" | "removeSongCover" | "deleteSong" | "listJobs" |
  "listRecordings" | "latestAnalysis" | "analyzeRecording" |
  "renameRecording" | "deleteRecording" | "createStudioMaster" | "diagnostics">;

export type LibraryFilesPort = Pick<DesktopClient,
  "pickAudioFile" | "pickAudioFiles" | "pickImageFile" | "pathForFile" | "statFile" |
  "revealProject" | "revealInExplorer">;

export type RecordingPreviewPort = Pick<AudioServiceClient,
  "playRecording" | "pauseRecordingPreview" | "seekRecordingPreview" |
  "stopRecordingPreview" | "recordingPreviewStatus" | "setPreviewVolume">;

export type LibraryJobEventsPort = {
  available(): boolean;
  subscribe(refresh: () => void, intervalMilliseconds: number): () => void;
};
