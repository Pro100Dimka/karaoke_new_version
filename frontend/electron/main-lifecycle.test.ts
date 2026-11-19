import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { mocks, contents, window } from '../test-fixtures/electronMain';

it('reveals the initial launch on appReady without requiring another launch', async () => {
  const { ipcChannels } = await import('./ipcChannels');
  window.show.mockClear();
  window.focus.mockClear();
  const secondLaunch = () =>
    mocks.appEvents.get('second-instance')?.({ preventDefault: vi.fn() }, [
      'AD Voice.exe',
    ]);
  expect(window.show).not.toHaveBeenCalled();
  await mocks.handlers.get(ipcChannels.appReady)?.({
    sender: contents,
    senderFrame: contents.mainFrame,
  } as IpcMainInvokeEvent);
  expect(window.show).toHaveBeenCalledOnce();
  secondLaunch();
  expect(window.show).toHaveBeenCalledTimes(2);
  expect(window.focus).toHaveBeenCalledOnce();
  expect(mocks.relaunch).not.toHaveBeenCalled();
});

it('keeps services alive while the renderer is confirming window close', () => {
  const event = { preventDefault: vi.fn() };
  mocks.appEvents.get('before-quit')?.(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(window.close).toHaveBeenCalledOnce();
  expect(mocks.stopService).not.toHaveBeenCalled();
});

it('requests relaunch through close approval and cancels it when the user stays', async () => {
  const { ipcChannels } = await import('./ipcChannels');
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame,
  } as IpcMainInvokeEvent;
  mocks.relaunch.mockClear();
  try {
    await mocks.handlers.get(ipcChannels.relaunchApp)?.(event);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await mocks.handlers.get(ipcChannels.confirmClose)?.(event, false);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await mocks.handlers.get(ipcChannels.relaunchApp)?.(event);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    await mocks.handlers.get(ipcChannels.confirmClose)?.(event, true);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  } finally {
    mocks.quit.mockClear();
  }
});

it.each(['reveal', 'close confirmation'])(
  'resets %s when activation replaces a closed main window',
  async (scenario) => {
    const { ipcChannels } = await import('./ipcChannels');
    const event = {
      sender: contents,
      senderFrame: contents.mainFrame,
    } as IpcMainInvokeEvent;
    mocks.handlers.get(ipcChannels.appReady)?.(event);
    await mocks.handlers.get(ipcChannels.confirmClose)?.(event, true);
    window.emit('closed');
    // The fixture reuses the native-window stand-in for the new BrowserWindow.
    window.removeAllListeners();
    contents.removeAllListeners();
    const shown = window.show.mock.calls.length;
    mocks.appEvents.get('activate')?.({ preventDefault: vi.fn() });

    if (scenario === 'reveal') {
      mocks.handlers.get(ipcChannels.appReady)?.(event);
      expect(window.show).toHaveBeenCalledTimes(shown + 1);
    } else {
      const closing = { preventDefault: vi.fn() };
      contents.send.mockClear();
      window.emit('close', closing);
      expect(closing.preventDefault).toHaveBeenCalledOnce();
      expect(contents.send).toHaveBeenCalledWith(ipcChannels.closeRequested);
    }
  },
);

it.each([
  'none',
  'launch',
  'update',
  'cancelled-update',
  'failed-update',
  'throwing-update',
  'settings-relaunch',
])(
  'defers quit until services stop and preserves the launch owner: %s',
  async (scenario) => {
    vi.resetModules();
    window.removeAllListeners();
    contents.removeAllListeners();
    mocks.stopService.mockReset();
    mocks.quit.mockClear();
    mocks.relaunch.mockClear();
    await import('./main');
    await mocks.ready.run();
    const { ipcChannels } = await import('./ipcChannels');
    const ipcEvent = {
      sender: contents,
      senderFrame: contents.mainFrame,
    } as IpcMainInvokeEvent;
    const confirm = (allowed: boolean) =>
      mocks.handlers.get(ipcChannels.confirmClose)?.(ipcEvent, allowed);
    if (scenario.includes('update')) {
      mocks.updateQuit.run();
      if (scenario === 'cancelled-update') await confirm(false);
      else if (scenario === 'failed-update') {
        mocks.prepareUpdateQuit.mockResolvedValueOnce(false);
        await confirm(true);
      } else if (scenario === 'throwing-update') {
        mocks.prepareUpdateQuit.mockRejectedValueOnce(
          new Error('installer failed'),
        );
        await expect(confirm(true)).rejects.toThrow('installer failed');
      } else await confirm(true);
    } else if (scenario === 'settings-relaunch') {
      await mocks.handlers.get(ipcChannels.relaunchApp)?.(ipcEvent);
      await confirm(true);
    }
    mocks.quit.mockClear();
    window.emit('closed');
    let finish!: () => void;
    mocks.stopService.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const event = { preventDefault: vi.fn() };
    mocks.appEvents.get('before-quit')?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(typeof mocks.stopService.mock.calls[0]?.[0]).toBe('function');
    expect(mocks.quit).not.toHaveBeenCalled();
    // No AudioService executable was launched by this instance in this fixture.
    expect(mocks.sendAudioRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'ShutdownService' }),
    );
    if (scenario !== 'none') {
      const launch = () =>
        mocks.appEvents.get('second-instance')?.({ preventDefault: vi.fn() }, [
          'AD Voice.exe',
          'D:/songs/open-me.wav',
        ]);
      launch();
      launch();
      if (scenario === 'update') expect(mocks.relaunch).not.toHaveBeenCalled();
      else
        expect(mocks.relaunch).toHaveBeenCalledExactlyOnceWith(
          scenario === 'settings-relaunch'
            ? undefined
            : { args: ['D:/songs/open-me.wav'] },
        );
      expect(mocks.quit).not.toHaveBeenCalled();
    } else expect(mocks.relaunch).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
  },
);
