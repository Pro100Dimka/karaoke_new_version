import { afterEach, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({
  failTray: false,
  constructed: vi.fn(),
}));
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: unknown) => template },
  Tray: class {
    constructor() {
      desktop.constructed();
      if (desktop.failTray) throw new Error('Tray icon is unreadable');
    }
    on() {}
    setToolTip() {}
    setContextMenu() {}
    destroy() {}
  },
}));

import { DesktopShell } from './DesktopShell';
import { createTrayRadio } from './TrayRadio';

afterEach(() => {
  desktop.failTray = false;
  desktop.constructed.mockClear();
});

it.each(['missing', 'unreadable'] as const)(
  'keeps the ordinary close flow when the tray icon is %s',
  (failure) => {
    desktop.failTray = failure === 'unreadable';
    const shell = new DesktopShell();
    const window = { isDestroyed: () => false, hide: vi.fn() };
    const notify = vi.fn();
    const tray = createTrayRadio({
      window: () => window as never,
      shell,
      iconPath: () => (failure === 'missing' ? null : 'broken.png'),
      notify,
      quit: vi.fn(),
      quitting: () => false,
    });
    shell.report({
      screen: 'library',
      radio: { available: true, enabled: true, station: 'Lofi' },
    });

    expect(tray.closeToTray()).toBe(false);
    expect(window.hide).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    tray.destroy();
  },
);

it('does not recreate the tray after the integration is destroyed', () => {
  const shell = new DesktopShell();
  const tray = createTrayRadio({
    window: () => null,
    shell,
    iconPath: () => 'icon.png',
    notify: vi.fn(),
    quit: vi.fn(),
    quitting: () => false,
  });
  shell.report({
    screen: 'library',
    radio: { available: true, enabled: true, station: 'First' },
  });
  expect(desktop.constructed).toHaveBeenCalledOnce();
  tray.destroy();
  shell.report({
    screen: 'library',
    radio: { available: true, enabled: true, station: 'Second' },
  });
  expect(desktop.constructed).toHaveBeenCalledOnce();
});
