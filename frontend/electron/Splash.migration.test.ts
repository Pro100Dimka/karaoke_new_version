import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  BrowserWindow: vi.fn(),
}));
const { hasPendingStorageMigration } = await import('./Splash');

beforeEach(async () => {
  state.root = await mkdtemp(path.join(tmpdir(), 'startup-migration-'));
});
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true });
});

it('allows service preparation when no migration owns the files', () => {
  expect(hasPendingStorageMigration()).toBe(false);
});

it.each(['.storage-cleanup', '.storage-migration', 'storage-progress.json'])(
  'keeps services waiting while %s exists',
  async (marker) => {
    await writeFile(path.join(state.root, marker), '{}');
    expect(hasPendingStorageMigration()).toBe(true);
  },
);

it('keeps completed progress behind the migration gate until cleanup clears it', async () => {
  const file = path.join(state.root, 'storage-progress.json');
  await writeFile(file, JSON.stringify({ phase: 'Done' }));
  expect(hasPendingStorageMigration()).toBe(true);
  await rm(file);
  expect(hasPendingStorageMigration()).toBe(false);
});
