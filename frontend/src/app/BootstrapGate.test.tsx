import { tr } from '@neo-ui-kit/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { runInAction } from 'mobx';
import { beforeEach, expect, it, vi } from 'vitest';
import Localization from '../providers/localization';
import { store } from '../providers/store';
import { BootstrapGate } from './BootstrapGate';
import type { ServiceStatus } from './serviceStatus';
import { TitleBar } from './TitleBar';

const desktop = vi.hoisted(() => ({
  appReady: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  minimize: vi.fn(async () => undefined),
  toggleFullscreen: vi.fn(async () => true),
  isFullscreen: vi.fn(async () => false),
  isMaximized: vi.fn(async () => false),
  onWindowState: vi.fn(() => () => undefined),
}));
vi.mock('../services/desktopClient', () => ({ desktopClient: desktop }));
vi.mock('../services/audioClient', () => ({
  audioClient: { setPreferredConfiguration: vi.fn() },
}));
vi.mock('./useAcousticLatencyAutoSave', () => ({
  useAcousticLatencyAutoSave: vi.fn(),
}));
vi.mock('./useLowLatencyMicrophoneNotice', () => ({
  useLowLatencyMicrophoneNotice: vi.fn(),
}));
vi.mock('../features/karaoke/console/voiceChain', () => ({
  useVoiceChain: vi.fn(),
}));

const probe = vi.fn(async () => undefined);
beforeEach(() => {
  vi.clearAllMocks();
  runInAction(() => {
    store.application.services.probe = probe;
  });
});

const showBootstrap = (status: ServiceStatus) => {
  runInAction(() => {
    store.application.services.python = status;
  });
  return render(
    <Localization>
      <BootstrapGate>
        <TitleBar />
        <div>Library content</div>
      </BootstrapGate>
    </Localization>,
  );
};

it.each<ServiceStatus>([
  { kind: 'unavailable' },
  { kind: 'incompatible', version: 'API 0', expected: 'API 1' },
])('keeps window controls usable when Python is $kind', async (status) => {
  showBootstrap(status);

  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByText('Library content')).not.toBeInTheDocument();
  expect(
    screen.getByRole('toolbar', { name: tr('windowControls') }),
  ).toBeVisible();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: tr('minimize') }));
    fireEvent.click(screen.getByRole('button', { name: tr('fullscreen') }));
    fireEvent.click(screen.getByRole('button', { name: tr('closeWindow') }));
    fireEvent.click(screen.getByRole('button', { name: tr('retry') }));
  });
  expect(desktop.minimize).toHaveBeenCalledOnce();
  expect(desktop.toggleFullscreen).toHaveBeenCalledOnce();
  expect(desktop.close).toHaveBeenCalledOnce();
  expect(probe).toHaveBeenCalledOnce();
});

it('hands window controls to the application shell after retry succeeds', async () => {
  showBootstrap({ kind: 'unavailable' });

  await act(async () => {
    runInAction(() => {
      store.application.services.python = { kind: 'ready', version: '1' };
    });
  });

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Library content')).toBeVisible();
  expect(
    screen.getAllByRole('toolbar', { name: tr('windowControls') }),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: tr('closeWindow') }));
  expect(desktop.close).toHaveBeenCalledOnce();
});
