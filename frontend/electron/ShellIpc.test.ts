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
    () =>
      ({ isDestroyed: () => false, webContents: currentSender }) as never,
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
