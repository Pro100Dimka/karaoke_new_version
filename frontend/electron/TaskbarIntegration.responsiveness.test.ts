import { expect, it, vi } from 'vitest';
import { DesktopShell } from './DesktopShell';
import { createTaskbarIntegration } from './TaskbarIntegration';

vi.mock('electron', () => ({ nativeImage: {} }));

const job = (state: string, overallProgress = 0) => ({
  type: 'job.changed',
  data: { jobId: 'song', state, overallProgress, type: 'SongProcessing' },
});
const makeWindow = () => ({
  isDestroyed: () => false,
  isVisible: () => true,
  isFocused: () => false,
  setProgressBar: vi.fn(),
  setOverlayIcon: vi.fn(),
  setThumbarButtons: vi.fn(),
  flashFrame: vi.fn(),
});
const setup = () => {
  let window = makeWindow();
  const notify = vi.fn();
  const integration = createTaskbarIntegration({
    window: () => window as never,
    shell: new DesktopShell(),
    notify,
    icon: vi.fn(),
  });
  return {
    window,
    notify,
    integration,
    replaceWindow: () => (window = makeWindow()),
  };
};

it('does not repeat native taskbar calls for unchanged progress or unrelated backend events', () => {
  const { integration, window } = setup();
  integration.backendEvent(job('Running', 0.4));
  for (let index = 0; index < 1000; index += 1) {
    integration.backendEvent(job('Running', 0.4));
    integration.backendEvent({ type: 'song.changed', data: { songId: 'other' } });
  }
  expect(window.setProgressBar).toHaveBeenCalledExactlyOnceWith(0.4, {
    mode: 'normal',
  });
  integration.backendEvent(job('Running', 0.40001));
  expect(window.setProgressBar).toHaveBeenLastCalledWith(0.40001, {
    mode: 'normal',
  });
  expect(window.setProgressBar).toHaveBeenCalledTimes(2);
});

it('applies progress to a replacement window and explicitly refreshes shell state', () => {
  const { integration, window, replaceWindow } = setup();
  integration.backendEvent(job('Queued'));
  expect(window.setProgressBar).toHaveBeenCalledExactlyOnceWith(2, {
    mode: 'indeterminate',
  });
  const replacement = replaceWindow();
  integration.backendEvent({ type: 'song.changed' });
  expect(replacement.setProgressBar).toHaveBeenCalledExactlyOnceWith(2, {
    mode: 'indeterminate',
  });
  integration.refresh();
  expect(replacement.setProgressBar).toHaveBeenCalledTimes(2);
});

it('keeps completion notifications, failed states and stream resets immediate', () => {
  const { integration, window, notify } = setup();
  integration.backendEvent(job('Running', 0.4));
  integration.backendEvent(job('Succeeded', 1));
  expect(window.setProgressBar).toHaveBeenLastCalledWith(-1, undefined);
  expect(notify).toHaveBeenCalledOnce();
  integration.backendEvent(job('Succeeded', 1));
  expect(notify).toHaveBeenCalledOnce();
  expect(window.setProgressBar).toHaveBeenCalledTimes(2);
  integration.backendEvent(job('Queued'));
  integration.backendEvent(job('Failed'));
  expect(notify).toHaveBeenCalledTimes(2);
  integration.backendEvent(job('Running', 0.8));
  integration.backendEvent({ type: 'connected' });
  expect(window.setProgressBar).toHaveBeenLastCalledWith(-1, undefined);
  expect(notify).toHaveBeenCalledTimes(2);
});
