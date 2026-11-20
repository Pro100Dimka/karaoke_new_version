import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { mocks, contents, window } from '../test-fixtures/electronMain';

it.each([
  [null, 200, 0, 100, null],
  ['bytes=10-19', 206, 10, 20, 'bytes 10-19/100'],
  ['bytes=90-', 206, 90, 100, 'bytes 90-99/100'],
  ['bytes=90-200', 206, 90, 100, 'bytes 90-99/100'],
  ['bytes=-10', 206, 90, 100, 'bytes 90-99/100'],
  ['bytes=-200', 206, 0, 100, 'bytes 0-99/100'],
  ['bytes=-0', 416, 0, 0, 'bytes */100'],
  ['bytes=200-', 416, 0, 0, 'bytes */100'],
  ['bytes=20-10', 416, 0, 0, 'bytes */100'],
] as const)(
  'serves the requested scene video byte range %s',
  async (range, status, start, end, contentRange) => {
    const root = join(mocks.profileRoot, 'range-project');
    const media = join(root, 'frontend', 'media', 'scene');
    await mkdir(media, { recursive: true });
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    await writeFile(join(media, 'test.webm'), bytes);
    const { registerSceneProtocol } =
      await vi.importActual<typeof import('./SceneProtocol')>(
        './SceneProtocol',
      );
    registerSceneProtocol(root);
    const response = await mocks.scene(
      new Request('scene://local/test.webm', {
        headers: range ? { Range: range } : {},
      }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      bytes.subarray(start, end),
    );
  },
);

const audio = async (sender: unknown, frame: unknown) => {
  const { ipcChannels } = await import('./ipcChannels');
  return mocks.handlers.get(ipcChannels.audioRequest)?.(
    { sender, senderFrame: frame } as IpcMainInvokeEvent,
    { command: 'GetServiceState' },
  );
};

it('keeps the approved window open when the installer cannot start', async () => {
  const { ipcChannels } = await import('./ipcChannels');
  mocks.prepareUpdateQuit.mockResolvedValueOnce(false);
  window.close.mockClear();
  await mocks.handlers.get(ipcChannels.confirmClose)?.(
    { sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent,
    true,
  );
  expect(window.close).not.toHaveBeenCalled();
  expect(mocks.prepareUpdateQuit).toHaveBeenCalledOnce();
});

it('selects the high-performance GPU before Chromium starts', () => {
  expect(mocks.gpuSwitch).toHaveBeenCalledWith('force-high-performance-gpu');
});

it('rejects other windows with a matching URL, subframes and detached frames', async () => {
  const untrusted = [
    [{ mainFrame: contents.mainFrame }, contents.mainFrame],
    [contents, { url: contents.mainFrame.url }],
    [contents, null],
  ];
  for (const [sender, frame] of untrusted)
    await expect(audio(sender, frame)).rejects.toThrow('Untrusted IPC sender');
  expect(mocks.sendAudioRequest).not.toHaveBeenCalled();
});
it('rejects remote and sibling local documents in the main window', async () => {
  for (const url of [
    'https://example.org',
    'file:///D:/Git/karaoke_new_version/frontend/dist/other.html',
    'about:blank',
  ]) {
    contents.mainFrame.url = url;
    await expect(audio(contents, contents.mainFrame)).rejects.toThrow(
      'Untrusted IPC sender',
    );
  }
});
it('allows the application main frame including hash routes', async () => {
  contents.mainFrame.url += '#/karaoke/song';
  await expect(audio(contents, contents.mainFrame)).resolves.toEqual({
    status: 0,
    text: 'Running',
  });
});
it('logs a failed AudioService command with its returned driver error', async () => {
  mocks.sendAudioRequest.mockResolvedValueOnce({
    status: -1,
    text: 'ASIO driver missing',
  });
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await audio(contents, contents.mainFrame);
    expect(logged).toHaveBeenCalledWith(
      'AudioService GetServiceState failed: ASIO driver missing',
    );
  } finally {
    logged.mockRestore();
  }
});
it('blocks navigation away from the application and allows only empty app panel windows', () => {
  const event = { preventDefault: vi.fn(), url: 'https://example.org' };
  contents.emit('will-navigate', event, event.url);
  expect(event.preventDefault).toHaveBeenCalled();
  const open = contents.setWindowOpenHandler.mock.calls.at(-1)?.[0] as
    | ((details: { url: string; frameName: string }) => { action: string })
    | undefined;
  expect(open?.({ url: 'https://example.org', frameName: '' })).toEqual({
    action: 'deny',
  });
  expect(
    open?.({ url: 'https://example.org', frameName: 'ad-voice-panel:room' }),
  ).toEqual({ action: 'deny' });
  expect(open?.({ url: 'about:blank', frameName: 'other' })).toEqual({
    action: 'deny',
  });
  expect(
    open?.({ url: 'about:blank', frameName: 'ad-voice-panel:room' }),
  ).toMatchObject({
    action: 'allow',
    overrideBrowserWindowOptions: {
      frame: false,
      transparent: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  });
});
it('keeps a panel window from navigating anywhere or opening windows', () => {
  const panelContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
  });
  const panelWindow = Object.assign(new EventEmitter(), {
    webContents: panelContents,
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => true,
    isMinimized: () => false,
  });
  contents.emit('did-create-window', panelWindow);
  const event = { preventDefault: vi.fn() };
  panelContents.emit('will-navigate', event);
  expect(event.preventDefault).toHaveBeenCalled();
  const open = panelContents.setWindowOpenHandler.mock.calls.at(-1)?.[0] as
    (() => { action: string }) | undefined;
  expect(open?.()).toEqual({ action: 'deny' });
});
it('applies sender validation to room project transfer IPC too', async () => {
  const { ipcChannels } = await import('./ipcChannels');
  for (const channel of [
    ipcChannels.uploadRoomProject,
    ipcChannels.downloadRoomProject,
    ipcChannels.cancelRoomProjectTransfer,
    ipcChannels.releaseRoomProjectDownload,
  ]) {
    await expect(async () =>
      mocks.handlers.get(channel)?.(
        { sender: contents, senderFrame: null } as IpcMainInvokeEvent,
        {},
      ),
    ).rejects.toThrow('Untrusted IPC sender');
  }
});
it.each(['.', '..', 'CON'])(
  'rejects unsafe local project identity %s',
  async (songId) => {
    const { ipcChannels } = await import('./ipcChannels');
    await expect(async () =>
      mocks.handlers.get(ipcChannels.resolveProjectArtifacts)?.(
        {
          sender: contents,
          senderFrame: contents.mainFrame,
        } as IpcMainInvokeEvent,
        { songId, revision: 1 },
      ),
    ).rejects.toThrow('Invalid project identity');
  },
);

it('inspects the actual WAV data chunk and available frames through the desktop IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspect-wave-test-'));
  try {
    const file = join(root, 'metadata.wav');
    const buffer = Buffer.alloc(44 + 8192 + 8 + 8);
    buffer.write('RIFF');
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24);
    buffer.writeUInt32LE(16000, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('JUNK', 36);
    buffer.writeUInt32LE(8192, 40);
    buffer.write('data', 44 + 8192);
    buffer.writeUInt32LE(32, 48 + 8192);
    await writeFile(file, buffer);
    const { ipcChannels } = await import('./ipcChannels');
    const result = await mocks.handlers.get(ipcChannels.inspectWave)?.(
      {
        sender: contents,
        senderFrame: contents.mainFrame,
      } as IpcMainInvokeEvent,
      file,
    );
    expect(result).toEqual({
      sampleRate: 8000,
      channels: 1,
      durationSeconds: 4 / 8000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses only the announced backend endpoint and discards it across restart', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetch);
  const { ipcChannels } = await import('./ipcChannels');
  const request = () =>
    mocks.handlers.get(ipcChannels.pythonRequest)?.(
      {
        sender: contents,
        senderFrame: contents.mainFrame,
      } as IpcMainInvokeEvent,
      { method: 'GET', path: '/health/ready' },
    );
  try {
    const pending = request();
    expect(fetch).not.toHaveBeenCalled();
    mocks.pythonObserver.stdout?.(Buffer.from('log line\nAD_VOICE_BACKEND_RE'));
    mocks.pythonObserver.stdout?.(Buffer.from('ADY:51234\n'));
    expect(await pending).toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:51234/health/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const signal = fetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    mocks.pythonObserver.stopped?.();
    expect(signal.aborted).toBe(true);
    expect(await request()).toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
