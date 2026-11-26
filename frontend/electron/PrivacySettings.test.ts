import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = vi.hoisted(() => ({ directory: '' }));
const permissions = vi.hoisted(() => ({
  choose: vi.fn(),
  files: vi.fn(),
  request: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => profile.directory, getLocale: () => 'en-US' },
  dialog: {
    showMessageBox: permissions.choose,
    showOpenDialog: permissions.files,
  },
}));
vi.mock('./RoomServerTransport', () => ({
  roomServerApiBase: 'https://rooms.example:443',
  roomServerRequest: permissions.request,
}));
vi.mock('./SocialIdentity', () => ({
  withDevice: async (request: unknown) => request,
}));
import { requestFileDeclaration } from './TransferPermissions';
import {
  diagnosticsConsent,
  saveDiagnosticsConsent,
  saveTransferConsent,
  transferConsents,
  transferConsentChanges,
} from './PrivacySettings';

beforeEach(() => {
  profile.directory = mkdtempSync(join(tmpdir(), 'diagnostic-consent-'));
  permissions.choose.mockReset().mockResolvedValue({ response: 1 });
  permissions.files
    .mockReset()
    .mockResolvedValue({ canceled: true, filePaths: [] });
  permissions.request
    .mockReset()
    .mockResolvedValue({ ok: true, body: { ticket: 'scoped-ticket' } });
});

afterEach(() => {
  if (profile.directory)
    rmSync(profile.directory, { recursive: true, force: true });
  profile.directory = '';
  vi.useRealTimers();
});

it('requires explicit current consent and persists withdrawal across restarts', () => {
  expect(diagnosticsConsent()).toEqual({ enabled: false, recordedAt: null });
  saveDiagnosticsConsent(true);
  expect(diagnosticsConsent().enabled).toBe(false);
  saveTransferConsent('online', true);
  saveTransferConsent('diagnostics', true);
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

it('keeps withdrawal pending across reads and preserves the decision time on acknowledgement', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
  saveTransferConsent('online', true);
  const changes: string[] = [];
  transferConsentChanges.once('withdraw', (purpose: string) =>
    changes.push(purpose),
  );
  saveTransferConsent('online', false, true);
  const pending = transferConsents().online;
  expect(pending).toMatchObject({ enabled: false, pending: true });
  expect(changes).toEqual(['online']);
  vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
  saveTransferConsent('online', false);
  expect(transferConsents().online).toEqual({ ...pending, pending: false });
});

it('does not accept consent for another server or a corrupt receipt', () => {
  saveTransferConsent('online', true);
  const file = join(profile.directory, 'transfer-consents.json');
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(
    file,
    JSON.stringify({ ...receipt, origin: 'https://other.example' }),
  );
  expect(transferConsents().online.enabled).toBe(false);
  writeFileSync(file, '{broken');
  expect(
    Object.values(transferConsents()).every((choice) => !choice.enabled),
  ).toBe(true);
});

it('does not upload diagnostics while either required permission is pending', () => {
  saveDiagnosticsConsent(true);
  saveTransferConsent('online', true);
  saveTransferConsent('diagnostics', true, true);
  expect(diagnosticsConsent().enabled).toBe(false);
});

it('never asks for or uploads a file without both required transfer choices', async () => {
  saveTransferConsent('online', true);
  await expect(
    requestFileDeclaration('processing', '/songs/song/processing'),
  ).rejects.toThrow('Privacy');
  expect(permissions.choose).not.toHaveBeenCalled();
  expect(permissions.request).not.toHaveBeenCalled();
});

it.each([
  [1, 'own'],
  [2, 'nonpersonal'],
] as const)(
  'records the selected file category %s for one operation',
  async (response, category) => {
    saveTransferConsent('online', true);
    saveTransferConsent('processing', true);
    permissions.choose.mockResolvedValue({ response });
    await expect(
      requestFileDeclaration('processing', '/songs/song/processing'),
    ).resolves.toBe('scoped-ticket');
    expect(permissions.request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          purpose: 'processing',
          resource: '/songs/song/processing',
          category,
          evidence: '',
        },
      }),
    );
    expect(permissions.files).not.toHaveBeenCalled();
  },
);

it('records only a hash of third-party permission evidence', async () => {
  saveTransferConsent('online', true);
  const evidence = join(profile.directory, 'permission.txt');
  writeFileSync(evidence, 'Synthetic permission evidence');
  permissions.choose.mockResolvedValue({ response: 3 });
  permissions.files.mockResolvedValue({
    canceled: false,
    filePaths: [evidence],
  });
  await requestFileDeclaration('online', '/rooms/room/projects/song/1');
  const request = permissions.request.mock.calls[0][0];
  expect(request.body.category).toBe('others');
  expect(request.body.evidence).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(request)).not.toContain('Synthetic permission');
  expect(JSON.stringify(request)).not.toContain(evidence);
});

it('accepts larger permission documents without sending their contents', async () => {
  saveTransferConsent('online', true);
  const evidence = join(profile.directory, 'large-permission.pdf');
  writeFileSync(evidence, Buffer.alloc(1024 * 1024 + 1, 90));
  permissions.choose.mockResolvedValue({ response: 3 });
  permissions.files.mockResolvedValue({
    canceled: false,
    filePaths: [evidence],
  });
  await expect(requestFileDeclaration('online', '/rooms/file')).resolves.toBe(
    'scoped-ticket',
  );
  expect(permissions.request.mock.calls[0][0].body.evidence).toMatch(
    /^sha256:[a-f0-9]{64}$/,
  );
});

it('cancels file sending when the dialog is declined or consent changes while it is open', async () => {
  saveTransferConsent('online', true);
  permissions.choose.mockResolvedValueOnce({ response: 0 });
  await expect(requestFileDeclaration('online', '/rooms/file')).rejects.toThrow(
    'cancelled',
  );
  permissions.choose.mockImplementationOnce(async () => {
    saveTransferConsent('online', false, true);
    return { response: 1 };
  });
  await expect(requestFileDeclaration('online', '/rooms/file')).rejects.toThrow(
    'withdrawn',
  );
  expect(permissions.request).not.toHaveBeenCalled();
});
