import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { commandsFromArguments } from './DesktopShell';
import { registerDesktopIpc } from './DesktopIpc';
import { ipcChannels } from './ipcChannels';
import type { TrustedIpc } from './TrustedIpc';

const showOpenDialog = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: { showOpenDialog },
  powerSaveBlocker: {},
  screen: {},
  shell: {},
}));
vi.mock('./Asio4AllInstaller', () => ({ launchAsio4AllInstaller: vi.fn() }));
vi.mock('./AppPaths', () => ({
  projectRoot: vi.fn(),
  saveStorageRoot: vi.fn(),
  themeIconPath: vi.fn(),
}));
vi.mock('./SceneProtocol', () => ({ pickSceneClip: vi.fn() }));
vi.mock('./Splash', () => ({ isThemeName: vi.fn(), saveTheme: vi.fn() }));

// Keep desktop entry points aligned with ImportSong's existing allowed suffixes.
const supported = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'];

it.each(supported)(
  'dispatches an existing %s file opened with the app',
  (ext) => {
    const path = resolve(`song.${ext.toUpperCase()}`);

    expect(commandsFromArguments([path], () => true)).toEqual([
      { type: 'importFiles', paths: [path] },
    ]);
    expect(commandsFromArguments([path], () => false)).toEqual([]);
  },
);

it.each([ipcChannels.pickAudioFile, ipcChannels.pickAudioFiles])(
  '%s makes every supported importer format selectable',
  async (channel) => {
    const handlers = new Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown
    >();
    const owner = {};
    registerDesktopIpc({
      trustedIpc: {
        handle: (channel: string, listener: never) =>
          handlers.set(channel, listener),
      } as unknown as TrustedIpc,
      window: () => owner as never,
      storageRoot: () => '',
      reveal: vi.fn(),
      confirmClose: vi.fn(),
      requestRelaunch: vi.fn(),
    });
    const paths = [resolve('song.opus')];
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: paths });

    const selected = await handlers.get(channel)?.({});

    expect(showOpenDialog).toHaveBeenLastCalledWith(owner, {
      properties:
        channel === ipcChannels.pickAudioFiles
          ? ['openFile', 'multiSelections']
          : ['openFile'],
      filters: [{ name: 'Audio', extensions: supported }],
    });
    expect(selected).toEqual(
      channel === ipcChannels.pickAudioFiles ? paths : paths[0],
    );
  },
);
