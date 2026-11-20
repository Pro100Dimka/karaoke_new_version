import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { mocks, contents, window } from '../test-fixtures/electronMain';
import type { ShellCommand } from './DesktopShell';

const installer = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawn: installer.spawn },
    spawn: installer.spawn,
  };
});

const payload = Buffer.alloc(200_000, 3);
const release = {
  tag_name: 'v1.1.5',
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'AD-Voice-Setup.exe',
      size: payload.length,
      browser_download_url:
        'https://github.com/Pro100Dimka/karaoke_new_version/releases/download/v1.1.5/AD-Voice-Setup.exe',
      digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    },
  ],
};

it.each([
  'initial-file',
  'initial-invitation',
  'initial-task',
  'pending-file',
  'pending-invitation',
  'pending-task',
  'pending-hash-file',
  'pending-ignored',
  'no-intent',
] as const)(
  'preserves an explicit launch when a cached automatic update is ready: %s',
  async (scenario) => {
    const electron = await import('electron');
    const originalRoot = mocks.profileRoot;
    const originalArguments = process.argv;
    const exitListeners = new Set(process.listeners('exit'));
    const app = {
      ...electron.app,
      isPackaged: true,
      getVersion: () => '1.1.3',
      isDefaultProtocolClient: () => true,
      setAsDefaultProtocolClient: vi.fn(),
      exit: vi.fn(),
    };
    vi.doMock('electron', () => ({
      ...electron,
      app,
      Menu: { setApplicationMenu: vi.fn() },
    }));
    vi.doUnmock('node:fs');
    vi.doUnmock('./AutoUpdate');
    vi.doUnmock('./DesktopLaunch');
    vi.resetModules();
    window.removeAllListeners();
    contents.removeAllListeners();
    installer.spawn.mockReset().mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    mocks.profileRoot = join(originalRoot, scenario);
    const updates = join(mocks.profileRoot, 'updates');
    await mkdir(updates, { recursive: true });
    const cachedInstaller = join(updates, 'AD-Voice-Setup-1.1.5.exe');
    await writeFile(cachedInstaller, payload);
    let finishHash!: () => void;
    const hashing = new Promise<void>((resolve) => {
      finishHash = resolve;
    });
    const hashStarted = vi.fn();
    if (scenario === 'pending-hash-file') {
      const actualFs =
        await vi.importActual<typeof import('node:fs')>('node:fs');
      const createReadStream: typeof actualFs.createReadStream = (
        source,
        options,
      ) => {
        if (source !== cachedInstaller)
          return actualFs.createReadStream(source, options);
        return Readable.from(
          (async function* () {
            hashStarted();
            await hashing;
            yield* actualFs.createReadStream(source, options);
          })(),
        ) as ReturnType<typeof actualFs.createReadStream>;
      };
      vi.doMock('node:fs', () => ({
        ...actualFs,
        createReadStream,
        default: { ...actualFs, createReadStream },
      }));
    }
    const mediaDirectory = join(mocks.profileRoot, 'selected-files');
    await mkdir(mediaDirectory);
    const file = join(mediaDirectory, 'chosen-song.wav');
    // This test follows the file-open command, before the backend imports/decodes its content.
    await writeFile(file, 'launch parsing only');
    const invitation = 'advoice://room/AB12CD?source=clip.wav';
    process.argv = [
      'AD Voice.exe',
      ...(scenario === 'initial-file' ? [file] : []),
      ...(scenario === 'initial-invitation' ? [invitation] : []),
      ...(scenario === 'initial-task' ? ['--add-song'] : []),
      ...(scenario === 'no-intent' ? ['--disable-gpu'] : []),
    ];
    let finishLookup!: () => void;
    const lookup = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const fetchRelease = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://api.github.com/repos/Pro100Dimka/karaoke_new_version/releases/latest',
      );
      await lookup;
      return new Response(JSON.stringify(release));
    });
    vi.stubGlobal('fetch', fetchRelease);
    let startup: unknown;
    try {
      await import('./main');
      const { registerShellIpc } = await import('./ShellIpc');
      const shell = vi.mocked(registerShellIpc).mock.calls.at(-1)?.[1];
      if (!shell) throw new Error('Main did not register the desktop shell');
      startup = mocks.ready.run();
      if (scenario.startsWith('pending-')) {
        // A second launch arrives while the real updater is awaiting release metadata.
        await vi.waitFor(() => expect(fetchRelease).toHaveBeenCalledOnce());
        if (scenario === 'pending-hash-file') {
          finishLookup();
          await vi.waitFor(() => expect(hashStarted).toHaveBeenCalledOnce());
        }
        mocks.appEvents.get('second-instance')?.(
          { preventDefault: vi.fn() },
          [
            'AD Voice.exe',
            scenario === 'pending-invitation'
              ? invitation
              : scenario === 'pending-task'
                ? '--add-song'
                : scenario === 'pending-ignored'
                  ? '--disable-gpu'
                  : 'chosen-song.wav',
          ],
          mediaDirectory,
        );
      }
      finishLookup();
      finishHash();
      await startup;
      const delivered = vi.fn<(command: ShellCommand) => void>();
      shell.connect(delivered);
      const actions = () =>
        delivered.mock.calls
          .map(([command]) => command)
          .filter((command) =>
            ['importFiles', 'joinRoom', 'addSong', 'openRoom'].includes(
              command.type,
            ),
          );

      if (scenario === 'no-intent' || scenario === 'pending-ignored') {
        expect(fetchRelease).toHaveBeenCalledOnce();
        expect(installer.spawn).toHaveBeenCalledExactlyOnceWith(
          cachedInstaller,
          ['/SILENT', '/NORESTART', '/CLOSEAPPLICATIONS'],
          expect.objectContaining({ detached: true, stdio: 'ignore' }),
        );
        expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
        expect(actions()).toEqual([]);
      } else {
        const expected: ShellCommand = scenario.endsWith('file')
          ? { type: 'importFiles', paths: [file] }
          : scenario.endsWith('task')
            ? { type: 'addSong' }
            : { type: 'joinRoom', code: 'AB12CD' };
        expect(
          actions(),
          JSON.stringify({
            installerStarts: installer.spawn.mock.calls.length,
            exits: app.exit.mock.calls,
          }),
        ).toEqual([expected]);
        expect(installer.spawn).not.toHaveBeenCalled();
        expect(app.exit).not.toHaveBeenCalled();
        expect(fetchRelease).toHaveBeenCalledTimes(
          scenario.startsWith('pending-') ? 1 : 0,
        );
        shell.disconnect();
        shell.connect(delivered);
        expect(actions()).toEqual([expected]);
      }
    } finally {
      finishLookup();
      finishHash();
      await startup;
      mocks.appEvents.get('will-quit')?.({ preventDefault: vi.fn() });
      process.argv = originalArguments;
      mocks.profileRoot = originalRoot;
      vi.doMock('electron', () => electron);
      vi.doUnmock('node:fs');
      vi.unstubAllGlobals();
      for (const listener of process.listeners('exit'))
        if (!exitListeners.has(listener))
          process.removeListener('exit', listener);
    }
  },
);
