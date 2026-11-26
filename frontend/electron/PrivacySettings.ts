import { app } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const policyVersion = '2026-11-26';
const file = () =>
  path.join(app.getPath('userData'), 'diagnostics-consent.json');

export const diagnosticsConsent = (): {
  enabled: boolean;
  recordedAt: string | null;
} => {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf8'));
    return {
      enabled: value.policyVersion === policyVersion && value.enabled === true,
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
