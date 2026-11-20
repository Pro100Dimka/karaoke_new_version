import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { mocks, contents, window } from '../test-fixtures/electronMain';
import type { ShellCommand } from './DesktopShell';

it.each(['readiness', 'migration', 'update', 'running'] as const)(
  'preserves launched files relative to the sending folder during %s',
  async (phase) => {
    vi.resetModules();
    // Exercise main's real event handler, argument parser and DesktopShell queue.
    vi.doUnmock('./DesktopLaunch');
    window.removeAllListeners();
    contents.removeAllListeners();
    mocks.beforeLaunch.mockReset().mockResolvedValue(false);
    const { waitForStorageMigration } = await import('./Splash');
    vi.mocked(waitForStorageMigration).mockReset().mockResolvedValue(undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (phase === 'migration')
      vi.mocked(waitForStorageMigration).mockReturnValueOnce(gate);
    if (phase === 'update')
      mocks.beforeLaunch.mockImplementationOnce(async () => {
        await gate;
        return false;
      });
    const originalArguments = process.argv;
    const exitListeners = new Set(process.listeners('exit'));
    process.argv = ['AD Voice.exe', '--add-song'];
    const launchDirectory = join(mocks.profileRoot, 'another-launch-folder');
    await mkdir(launchDirectory, { recursive: true });
    const file = join(launchDirectory, 'queued-song.wav');
    await writeFile(file, 'launch parsing only');
    let startup: unknown;
    try {
      await import('./main');
      const { registerShellIpc } = await import('./ShellIpc');
      const shell = vi.mocked(registerShellIpc).mock.calls.at(-1)?.[1];
      expect(shell).toBeDefined();
      if (!shell) throw new Error('Main did not register the desktop shell');
      const launch = (args: string[]) =>
        mocks.appEvents.get('second-instance')?.(
          { preventDefault: vi.fn() },
          ['AD Voice.exe', ...args],
          launchDirectory,
        );
      if (phase !== 'readiness') startup = mocks.ready.run();
      if (phase === 'running') await startup;
      if (phase === 'update')
        await vi.waitFor(() =>
          expect(mocks.beforeLaunch).toHaveBeenCalledOnce(),
        );
      launch(['advoice://room/early42']);
      launch(['--open-room', 'queued-song.wav']);
      if (phase === 'readiness') startup = mocks.ready.run();
      release();
      await startup;

      const delivered = vi.fn<(command: ShellCommand) => void>();
      shell.connect(delivered);
      const actions = () =>
        delivered.mock.calls
          .map(([command]) => command)
          .filter((command) => !['displays', 'power'].includes(command.type));
      expect(actions()).toEqual([
        { type: 'addSong' },
        { type: 'joinRoom', code: 'EARLY42' },
        { type: 'openRoom' },
        { type: 'importFiles', paths: [file] },
      ]);
      // A replacement renderer must not receive the already-consumed launch again.
      shell.disconnect();
      shell.connect(delivered);
      expect(actions()).toHaveLength(4);
      launch(['advoice://room/late42']);
      expect(actions()).toHaveLength(5);
      expect(actions().at(-1)).toEqual({ type: 'joinRoom', code: 'LATE42' });
      launch([file]);
      expect(actions()).toHaveLength(6);
      expect(actions().at(-1)).toEqual({ type: 'importFiles', paths: [file] });
    } finally {
      release();
      await startup;
      mocks.appEvents.get('will-quit')?.({ preventDefault: vi.fn() });
      process.argv = originalArguments;
      for (const listener of process.listeners('exit'))
        if (!exitListeners.has(listener))
          process.removeListener('exit', listener);
    }
  },
);
