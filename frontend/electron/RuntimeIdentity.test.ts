import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { App } from 'electron';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { configureRuntimeIdentity } from './RuntimeIdentity';

beforeEach(() => vi.stubEnv('AD_VOICE_PROFILE_ROOT', undefined));
afterEach(() => vi.unstubAllEnvs());

it('passes the installed language into the renderer environment', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ad-voice-language-'));
  const executable = process.execPath;
  const originalEnvironment = { ...process.env };
  try {
    mkdirSync(path.join(root, 'data'));
    writeFileSync(path.join(root, 'data', 'installer-language'), 'uk');
    Object.defineProperty(process, 'execPath', {
      value: path.join(root, 'AD Voice.exe'),
    });
    configureRuntimeIdentity({
      isPackaged: true,
      getPath: () => path.join(root, 'legacy'),
      setName: vi.fn(),
      setPath: vi.fn(),
    } as unknown as App);
    expect(process.env.AD_VOICE_LANGUAGE).toBe('uk');
  } finally {
    Object.defineProperty(process, 'execPath', { value: executable });
    for (const name of Object.keys(process.env))
      if (!(name in originalEnvironment)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
    rmSync(root, { recursive: true, force: true });
  }
});

it('lets the operating system allocate the managed backend port', () => {
  vi.stubEnv('AD_VOICE_PORT', undefined);
  const app = {
    isPackaged: false,
    getPath: () => 'D:/profiles',
    setName: vi.fn(),
    setPath: vi.fn(),
  };
  configureRuntimeIdentity(app as unknown as App);
  expect(process.env.AD_VOICE_PORT).toBe('0');
});

it('isolates audio endpoints for custom profiles without a manually assigned pipe', () => {
  const endpoints: string[] = [];
  for (const profile of ['AD Voice Dev', 'guest one', 'guest two']) {
    vi.stubEnv('AD_VOICE_PROFILE', profile);
    vi.stubEnv('AD_VOICE_AUDIO_ENDPOINT', undefined);
    configureRuntimeIdentity({
      isPackaged: false,
      getPath: () => 'D:/profiles',
      setName: vi.fn(),
      setPath: vi.fn(),
    } as unknown as App);
    endpoints.push(process.env.AD_VOICE_AUDIO_ENDPOINT ?? '');
  }
  expect(new Set(endpoints).size).toBe(3);
});

it.each(['.', '..', 'CON', 'NUL.config', 'COM1', 'LPT²', 'profile.'])(
  'keeps the profile inside AppData for invalid Windows directory %s',
  (profile) => {
    vi.stubEnv('AD_VOICE_PROFILE', profile);
    const app = {
      isPackaged: false,
      getPath: () => 'D:/profiles',
      setName: vi.fn(),
      setPath: vi.fn(),
    };
    configureRuntimeIdentity(app as unknown as App);
    expect(app.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('D:/profiles', 'AD Voice Dev'),
    );
  },
);
