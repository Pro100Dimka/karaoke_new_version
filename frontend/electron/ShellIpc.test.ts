import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { DesktopShell } from './DesktopShell';
import { ipcChannels } from './ipcChannels';
import type { TrustedIpc } from './TrustedIpc';

vi.mock('electron', () => ({ Notification: {} }));

const createSender = () =>
  Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
  });

const setup = async () => {
  const { registerShellIpc } = await import('./ShellIpc');
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const sender = createSender();
  let currentSender = sender;
  const shell = new DesktopShell();
  registerShellIpc(
    {
      handle: (channel: string, listener: never) =>
        handlers.set(channel, listener),
    } as unknown as TrustedIpc,
    shell,
    () => ({ isDestroyed: () => false, webContents: currentSender }) as never,
    vi.fn(),
  );
  const ready = (value: boolean) =>
    handlers.get(ipcChannels.shellReady)!({ sender: currentSender }, value);
  const replaceRenderer = () => (currentSender = createSender());
  return { shell, sender, ready, replaceRenderer };
};

it.each(['render-process-gone', 'destroyed', 'reload'])(
  'queues desktop commands after the renderer ends through %s until its replacement is ready',
  async (event) => {
    const { shell, sender, ready } = await setup();
    ready(true);
    shell.send({ type: 'addSong' });
    expect(sender.send).toHaveBeenCalledOnce();

    if (event === 'reload')
      sender.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
    else sender.emit(event);
    shell.send({ type: 'importFiles', paths: ['/music/song.wav'] });
    expect(sender.send).toHaveBeenCalledOnce();

    ready(true);
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenLastCalledWith(ipcChannels.shellCommand, {
      type: 'importFiles',
      paths: ['/music/song.wav'],
    });
    ready(true);
    expect(sender.send).toHaveBeenCalledTimes(2);
  },
);

it('keeps desktop commands connected during subframe and same-document navigation', async () => {
  const { shell, sender, ready } = await setup();
  ready(true);
  sender.emit('did-start-navigation', {
    isMainFrame: false,
    isSameDocument: false,
  });
  sender.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true,
  });
  shell.send({ type: 'addSong' });
  expect(sender.send).toHaveBeenCalledWith(ipcChannels.shellCommand, {
    type: 'addSong',
  });
});

it.each(['render-process-gone', 'destroyed', 'reload'])(
  'restores display availability and update state to the replacement renderer after %s',
  async (event) => {
    const { shell, sender, ready, replaceRenderer } = await setup();
    ready(true);
    shell.send({ type: 'displays', count: 2 });
    shell.send({ type: 'updateReady', version: '2.0.0' });
    shell.send({ type: 'addSong' });
    shell.send({ type: 'importFiles', paths: ['/music/already-opened.wav'] });
    shell.send({ type: 'joinRoom', code: 'AB12' });

    if (event === 'reload')
      sender.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
    else sender.emit(event);
    const replacement = replaceRenderer();
    const queuedImport = {
      type: 'importFiles' as const,
      paths: ['/music/after-reload.wav'],
    };
    shell.send(queuedImport);
    ready(true);

    expect(replacement.send).toHaveBeenCalledTimes(3);
    expect(replacement.send).toHaveBeenCalledWith(ipcChannels.shellCommand, {
      type: 'displays',
      count: 2,
    });
    expect(replacement.send).toHaveBeenCalledWith(ipcChannels.shellCommand, {
      type: 'updateReady',
      version: '2.0.0',
    });
    expect(replacement.send).toHaveBeenLastCalledWith(
      ipcChannels.shellCommand,
      queuedImport,
    );
    ready(true);
    expect(
      replacement.send.mock.calls.filter(([, command]) =>
        ['addSong', 'importFiles', 'joinRoom'].includes(command.type),
      ),
    ).toEqual([[ipcChannels.shellCommand, queuedImport]]);
  },
);

it('restores only the latest display count after monitor changes while disconnected', async () => {
  const { shell, sender, ready, replaceRenderer } = await setup();
  ready(true);
  shell.send({ type: 'displays', count: 2 });
  sender.emit('render-process-gone');
  const replacement = replaceRenderer();
  shell.send({ type: 'displays', count: 3 });
  shell.send({ type: 'addSong' });
  shell.send({ type: 'displays', count: 1 });
  shell.send({ type: 'displays', count: 4 });
  ready(true);

  expect(replacement.send.mock.calls).toEqual([
    [ipcChannels.shellCommand, { type: 'displays', count: 4 }],
    [ipcChannels.shellCommand, { type: 'addSong' }],
  ]);
});

it('keeps the monitor snapshot while update offers, failures and completed retries replace one another', async () => {
  const { shell, sender, ready, replaceRenderer } = await setup();
  ready(true);
  shell.send({ type: 'displays', count: 2 });
  for (const update of [
    { type: 'updateAvailable', version: '2.0.0' },
    { type: 'updateProgress', percent: 25 },
    { type: 'updateFailed' },
    { type: 'updateProgress', percent: 75 },
    { type: 'updateReady', version: '2.0.0' },
    { type: 'updateAvailable', version: '3.0.0' },
    { type: 'updateProgress', percent: 25 },
    { type: 'updateFailed' },
  ] as const)
    shell.send(update);
  sender.emit('render-process-gone');
  const replacement = replaceRenderer();
  ready(true);
  expect(replacement.send.mock.calls).toEqual([
    [ipcChannels.shellCommand, { type: 'displays', count: 2 }],
    [ipcChannels.shellCommand, { type: 'updateAvailable', version: '3.0.0' }],
    [ipcChannels.shellCommand, { type: 'updateFailed' }],
  ]);

  shell.send({ type: 'updateProgress', percent: 75 });
  shell.send({ type: 'updateReady', version: '3.0.0' });
  replacement.emit('render-process-gone');
  const recovered = replaceRenderer();
  ready(true);
  expect(recovered.send.mock.calls).toEqual([
    [ipcChannels.shellCommand, { type: 'displays', count: 2 }],
    [ipcChannels.shellCommand, { type: 'updateReady', version: '3.0.0' }],
  ]);
});

it('detaches the previous renderer so its late lifecycle events cannot disconnect the new owner', async () => {
  const { shell, sender, ready, replaceRenderer } = await setup();
  ready(true);
  const replacement = replaceRenderer();
  ready(true);
  expect(sender.eventNames()).toEqual([]);

  sender.emit('render-process-gone');
  sender.emit('destroyed');
  sender.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
  });
  shell.send({ type: 'addSong' });
  expect(sender.send).not.toHaveBeenCalled();
  expect(replacement.send).toHaveBeenCalledOnce();

  ready(true);
  expect(replacement.listenerCount('did-start-navigation')).toBe(1);
  expect(replacement.listenerCount('render-process-gone')).toBe(1);
  expect(replacement.listenerCount('destroyed')).toBe(1);
  ready(false);
  expect(replacement.eventNames()).toEqual([]);
  shell.send({ type: 'importFiles', paths: ['/music/next.wav'] });
  expect(replacement.send).toHaveBeenCalledOnce();
  ready(true);
  expect(replacement.send).toHaveBeenCalledTimes(2);
});
