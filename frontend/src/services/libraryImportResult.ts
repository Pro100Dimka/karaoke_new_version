import type { LibraryImportResultDto } from '../contracts/models';

const recordingCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

export const mapLibraryImportResult = (
  report: Record<string, unknown>,
): LibraryImportResultDto => {
  if (typeof report.imported !== 'number' || typeof report.skipped !== 'number')
    throw new Error('Library import completed without its result');
  const added = recordingCount(report.recordingsAdded);
  const skipped = recordingCount(report.recordingsSkipped);
  return {
    imported: report.imported,
    skipped: report.skipped,
    ...(added === undefined ? {} : { recordingsAdded: added }),
    ...(skipped === undefined ? {} : { recordingsSkipped: skipped }),
  };
};
