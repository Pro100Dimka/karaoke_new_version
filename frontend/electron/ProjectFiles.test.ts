import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';
import * as path from 'node:path';
import { ipcChannels } from './ipcChannels';
import { registerProjectFileHandlers } from './ProjectFiles';

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(shell.openPath).mockResolvedValue('');
});

const dataRoot = path.resolve('managed-project-test-data');
const projectHandlers = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const request = vi.fn();
  registerProjectFileHandlers(
    () => dataRoot,
    { request } as never,
    {
      handle: (channel, listener) =>
        handlers.set(channel, listener as (...args: unknown[]) => unknown),
    },
    async () => [],
  );
  return {
    request,
    invoke: (channel: string, value: unknown) =>
      Promise.resolve().then(() => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`Missing handler: ${channel}`);
        return handler({}, value);
      }),
  };
};

describe('song folder IPC', () => {
  it('opens an imported song managed folder without requiring a published revision', async () => {
    const { invoke, request } = projectHandlers();
    await invoke(ipcChannels.revealProject, {
      songId: 'imported',
      revision: 0,
    });
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(
      path.join(dataRoot, 'songs', 'imported'),
    );
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps revealing the manifest of a processed song revision', async () => {
    await projectHandlers().invoke(ipcChannels.revealProject, {
      songId: 'processed',
      revision: 7,
    });
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
      path.join(
        dataRoot,
        'songs',
        'processed',
        'revisions',
        '7',
        'manifest.json',
      ),
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('rejects an operating-system folder-open failure', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Folder is unavailable');
    await expect(
      projectHandlers().invoke(ipcChannels.revealProject, {
        songId: 'imported',
        revision: 0,
      }),
    ).rejects.toThrow('Folder is unavailable');
  });

  for (const revision of [0, 7])
    it.each(['../outside', '..\\outside', 'CON', ''])(
      `rejects unsafe song identity %j for revision ${revision}`,
      async (songId) => {
        await expect(
          projectHandlers().invoke(ipcChannels.revealProject, {
            songId,
            revision,
          }),
        ).rejects.toThrow('Invalid project identity');
        expect(shell.openPath).not.toHaveBeenCalled();
        expect(shell.showItemInFolder).not.toHaveBeenCalled();
      },
    );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid revision %s instead of opening the song folder',
    async (revision) => {
      await expect(
        projectHandlers().invoke(ipcChannels.revealProject, {
          songId: 'song',
          revision,
        }),
      ).rejects.toThrow('Invalid project identity');
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it('still rejects revision zero when resolving playable project artifacts', async () => {
    await expect(
      projectHandlers().invoke(ipcChannels.resolveProjectArtifacts, {
        songId: 'imported',
        revision: 0,
      }),
    ).rejects.toThrow('Invalid project identity');
  });
});

describe('recording peaks IPC', () => {
  it('reads the imported song waveform from the backend while no instrumental revision exists', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const request = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: [0, 0.7, 1],
    }));
    registerProjectFileHandlers(
      () => 'E:/CodexTemp/advoice-missing-project',
      { request } as never,
      {
        handle: (channel, listener) =>
          handlers.set(channel, listener as (...args: unknown[]) => unknown),
      },
    );
    await expect(
      handlers.get(ipcChannels.waveformPeaks)?.(
        {},
        { songId: 'imported', revision: 1, bins: 32 },
      ),
    ).resolves.toEqual([0, 0.7, 1]);
    expect(request).toHaveBeenCalledWith('/songs/imported/waveform?bins=32');
  });
  it('returns no peaks when the recording file no longer exists', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerProjectFileHandlers(
      () => 'unused',
      {
        request: vi.fn(async () => ({
          ok: true,
          status: 200,
          body: { filePath: 'Z:/missing/recording.wav' },
        })),
      } as never,
      {
        handle: (channel, listener) =>
          handlers.set(channel, listener as (...args: unknown[]) => unknown),
      },
    );

    const handler = handlers.get(ipcChannels.recordingPeaks);
    await expect(
      handler?.({}, { recordingId: 'missing', bins: 64 }),
    ).resolves.toEqual([]);
  });
});
