import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => profile.directory } }));
import { diagnosticsConsent, saveDiagnosticsConsent } from './PrivacySettings';

afterEach(() => {
  if (profile.directory)
    rmSync(profile.directory, { recursive: true, force: true });
  profile.directory = '';
});

it('requires explicit current consent and persists withdrawal across restarts', () => {
  profile.directory = mkdtempSync(join(tmpdir(), 'diagnostic-consent-'));
  expect(diagnosticsConsent()).toEqual({ enabled: false, recordedAt: null });
  saveDiagnosticsConsent(true);
  const receipt = diagnosticsConsent();
  expect(receipt.enabled).toBe(true);
  expect(receipt.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const file = join(profile.directory, 'diagnostics-consent.json');
  expect(JSON.parse(readFileSync(file, 'utf8')).policyVersion).toBe(
    '2026-11-26',
  );
  saveDiagnosticsConsent(false);
  expect(diagnosticsConsent().enabled).toBe(false);
  writeFileSync(file, JSON.stringify({ enabled: true, policyVersion: 'old' }));
  expect(diagnosticsConsent().enabled).toBe(false);
});
