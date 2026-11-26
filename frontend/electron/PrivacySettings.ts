import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { roomServerApiBase } from './RoomServerTransport';

const policyVersion = '2026-11-26';
export const transferConsentVersion = '2026-11-26.1';
export const transferPurposes = [
  'online',
  'processing',
  'diagnostics',
] as const;
export type TransferPurpose = (typeof transferPurposes)[number];
export const transferConsentChanges = new EventEmitter();
interface TransferChoice {
  enabled: boolean;
  recordedAt: string | null;
  pending: boolean;
}
const transferFile = () =>
  path.join(app.getPath('userData'), 'transfer-consents.json');
export const transferConsents = (): Record<TransferPurpose, TransferChoice> => {
  let saved: Record<string, TransferChoice> = {};
  try {
    const value = JSON.parse(readFileSync(transferFile(), 'utf8'));
    if (
      value.version === transferConsentVersion &&
      value.origin === roomServerApiBase
    )
      saved = value.choices ?? {};
  } catch {
    /* Missing or unreadable consent never enables transfers. */
  }
  return Object.fromEntries(
    transferPurposes.map((purpose) => [
      purpose,
      {
        enabled: saved[purpose]?.enabled === true,
        recordedAt:
          typeof saved[purpose]?.recordedAt === 'string'
            ? saved[purpose].recordedAt
            : null,
        pending: saved[purpose]?.pending === true,
      },
    ]),
  ) as Record<TransferPurpose, TransferChoice>;
};
export const saveTransferConsent = (
  purpose: TransferPurpose,
  enabled: boolean,
  pending = false,
): void => {
  const choices = transferConsents();
  const previous = choices[purpose];
  choices[purpose] = {
    enabled,
    pending,
    recordedAt:
      previous.enabled === enabled && previous.recordedAt
        ? previous.recordedAt
        : new Date().toISOString(),
  };
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(
    transferFile() + '.tmp',
    JSON.stringify({
      version: transferConsentVersion,
      origin: roomServerApiBase,
      choices,
    }),
    'utf8',
  );
  renameSync(transferFile() + '.tmp', transferFile());
  if (!enabled) transferConsentChanges.emit('withdraw', purpose);
};
const file = () =>
  path.join(app.getPath('userData'), 'diagnostics-consent.json');

export const diagnosticsConsent = (): {
  enabled: boolean;
  recordedAt: string | null;
} => {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf8'));
    return {
      enabled:
        value.policyVersion === policyVersion &&
        value.enabled === true &&
        transferConsents().online.enabled &&
        !transferConsents().online.pending &&
        transferConsents().diagnostics.enabled &&
        !transferConsents().diagnostics.pending,
      recordedAt:
        typeof value.recordedAt === 'string' ? value.recordedAt : null,
    };
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      (error as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      console.warn(
        'Could not read diagnostic consent; uploads remain disabled',
      );
    return { enabled: false, recordedAt: null };
  }
};

export const saveDiagnosticsConsent = (enabled: boolean): void => {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(
    file() + '.tmp',
    JSON.stringify({
      policyVersion,
      enabled,
      recordedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  renameSync(file() + '.tmp', file());
};
