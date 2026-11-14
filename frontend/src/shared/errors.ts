import { tr } from '@neo-ui-kit/react';
import { createCommandQueue } from '../app/desktop/shellBus';
import type { AppError } from '../contracts/models';
import { unverifiedAsioMonitoring } from '../contracts/models';

export const operationFailures = createCommandQueue<{
  operation: string;
  error: unknown;
}>();
const failedOperations = new Set<string>();

export const clearOperationFailure = (operation: string): void => {
  failedOperations.delete(operation);
};

export const reportOperationFailure = (
  operation: string,
  error: unknown,
): void => {
  const errors: unknown[] =
    error instanceof AggregateError ? error.errors : [error];
  if (
    errors.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        (('name' in item &&
          ['AbortError', 'AcousticMeasurementCancelled'].includes(
            String(item.name),
          )) ||
          ('code' in item && item.code === 'JobCancelled')),
    )
  )
    return;
  if (failedOperations.has(operation)) return;
  failedOperations.add(operation);
  console.error(operation, error);
  operationFailures.push({ operation, error });
};

/** A successful retry rearms the notice; repeated failures stay silent until recovery. */
export const observeOperation = <T>(
  operation: string,
  promise: Promise<T>,
): Promise<T> =>
  promise.then(
    (value) => {
      clearOperationFailure(operation);
      return value;
    },
    (error: unknown) => {
      reportOperationFailure(operation, error);
      throw error;
    },
  );

export const toAppError = (value: unknown): AppError => {
  if (
    value &&
    typeof value === 'object' &&
    'code' in value &&
    'message' in value
  ) {
    return value as AppError;
  }
  return {
    code: 'Unknown',
    message: value instanceof Error ? value.message : 'Unexpected error',
    source: 'frontend',
  };
};

/** UI branches on the stable error code, never on message text. */
const knownCodes = {
  ProcessingNotConfigured: 'errorProcessingNotConfigured',
  ProcessingAccessDenied: 'errorProcessingAccessDenied',
  ProcessingFreeLimitReached: 'errorProcessingFreeLimit',
  ProcessingFileTooLarge: 'errorProcessingFileTooLarge',
  ProcessingStorageFull: 'errorProcessingStorageFull',
  ProcessingUnavailable: 'errorProcessingUnavailable',
  ProcessingTimeout: 'errorProcessingTimeout',
  DuplicateSong: 'errorDuplicateSong',
  InvalidMedia: 'errorInvalidMedia',
  UnsupportedMedia: 'errorUnsupportedMedia',
  SourceMissing: 'errorSourceMissing',
  InsufficientDiskSpace: 'errorInsufficientDisk',
  InsufficientRam: 'errorInsufficientRam',
  ModelsInUse: 'errorModelsInUse',
  LibraryInUse: 'errorLibraryInUse',
  RecordingPreparing: 'recordingPreparing',
  RecordingTimingUnavailable: 'errorRecordingTimingUnavailable',
  StorageUnavailable: 'errorStorageUnavailable',
  MissingRequiredModels: 'errorMissingModels',
  ProcessingAlreadyRunning: 'errorProcessingRunning',
  AnalysisPitchUncertain: 'analysisPitchUncertain',
  JobCancelled: 'jobCancelled',
  RevisionConflict: 'errorRevisionConflict',
  ProjectInvalid: 'errorProjectInvalid',
  ProjectUpgradeRequired: 'errorProjectUpgrade',
  UnsupportedProjectVersion: 'errorProjectTooNew',
  RoomNotFound: 'errorRoomNotFound',
  RoomPermissionDenied: 'errorRoomPermission',
  RoomFull: 'errorRoomFull',
  ApiVersionMismatch: 'pythonIncompatible',
  FriendCodeNotFound: 'errorFriendCodeNotFound',
  FriendIsSelf: 'errorFriendIsSelf',
  TransferCodeNotFound: 'errorTransferCodeNotFound',
  UnsupportedAvatar: 'errorAvatarRejected',
  AvatarTooLarge: 'errorAvatarRejected',
} as const satisfies Record<string, string>;

export const errorstring = (error: AppError): string | null =>
  (knownCodes as Record<string, string>)[error.code] ?? null;

export const monitoringErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.message === unverifiedAsioMonitoring) {
      return tr('monitoringAsio4AllBlocked');
    }
    return error.message;
  }
  return String(error);
};
