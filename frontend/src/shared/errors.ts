import type { AppError } from "../contracts/models";
import type { MessageKey } from "../i18n/messages";

export const toAppError = (value: unknown): AppError => {
  if (value && typeof value === "object" && "code" in value && "message" in value) {
    return value as AppError;
  }
  return {
    code: "Unknown",
    message: value instanceof Error ? value.message : "Unexpected error",
    source: "frontend"
  };
};

/** UI branches on the stable error code, never on message text. */
const knownCodes = {
  DuplicateSong: "errorDuplicateSong",
  InvalidMedia: "errorInvalidMedia",
  UnsupportedMedia: "errorUnsupportedMedia",
  SourceMissing: "errorSourceMissing",
  InsufficientDiskSpace: "errorInsufficientDisk",
  StorageUnavailable: "errorStorageUnavailable",
  MissingRequiredModels: "errorMissingModels",
  ProcessingAlreadyRunning: "errorProcessingRunning",
  RevisionConflict: "errorRevisionConflict",
  ProjectInvalid: "errorProjectInvalid",
  ProjectUpgradeRequired: "errorProjectUpgrade",
  UnsupportedProjectVersion: "errorProjectTooNew",
  RoomNotFound: "errorRoomNotFound",
  RoomPermissionDenied: "errorRoomPermission",
  RoomFull: "errorRoomFull",
  ApiVersionMismatch: "pythonIncompatible"
} as const satisfies Record<string, MessageKey>;

export const errorMessageKey = (error: AppError): MessageKey | null =>
  (knownCodes as Record<string, MessageKey>)[error.code] ?? null;
