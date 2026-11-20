import { act, renderHook } from '@testing-library/react';
import { setLocale, tr } from '@neo-ui-kit/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '../../../../../../providers/localization';
import { desktopClient } from '../../../../../../services/desktopClient';
import { pythonClient } from '../../../../../../services/pythonClient';
import type { SubsystemHealth } from '../useSubsystemHealth';
import { useDiagnosticsActions } from './useDiagnosticsActions';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../providers/notifications', () => ({
  useNotify: () => notify,
}));
vi.mock('../../../../../../services/pythonClient', () => ({
  pythonClient: { listJobs: vi.fn() },
}));
vi.mock('../../../../../../services/desktopClient', () => ({
  desktopClient: {
    keyboardLightingCapabilities: vi.fn(),
    copyText: vi.fn(),
    saveTextFile: vi.fn(),
  },
}));

const health: SubsystemHealth = {
  failed: true,
  loading: false,
  backend: null,
  audio: { ServiceState: 'Running', XRuns: '3' },
  audioVersion: '1.0',
  refresh: () => {},
};

beforeEach(() => {
  vi.resetAllMocks();
  setLocale('en');
  vi.mocked(pythonClient.listJobs).mockResolvedValue([]);
  vi.mocked(desktopClient.keyboardLightingCapabilities).mockResolvedValue({
    available: false,
    deviceCount: 0,
  });
  vi.mocked(desktopClient.copyText).mockResolvedValue(undefined);
  vi.mocked(desktopClient.saveTextFile).mockResolvedValue(true);
});

it.each(['clipboard', 'file'] as const)(
  'delivers available diagnostics to %s when the backend cannot list jobs',
  async (destination) => {
    vi.mocked(pythonClient.listJobs).mockRejectedValue(
      new Error('Python backend stopped'),
    );
    const { result } = renderHook(() => useDiagnosticsActions(health));
    await act(() => result.current.deliverReport(destination));

    const report =
      destination === 'clipboard'
        ? vi.mocked(desktopClient.copyText).mock.calls[0]?.[0]
        : vi.mocked(desktopClient.saveTextFile).mock.calls[0]?.[1];
    expect(report).toBeDefined();
    expect(JSON.parse(report ?? '{}')).toMatchObject({
      pythonBackend: 'unavailable',
      audioService: health.audio,
      failedProcessing: 'unavailable',
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      tr(destination === 'clipboard' ? 'copied' : 'reportExported'),
      'success',
    );
  },
);

it('retains actual job errors when the backend is available', async () => {
  const error = {
    code: 'SourceMissing',
    message: 'Input missing',
    source: 'python',
  } as const;
  vi.mocked(pythonClient.listJobs).mockResolvedValue([
    {
      id: 'failed',
      type: 'SongProcessing',
      songId: 'song',
      state: 'failed',
      stage: 'Import',
      progress: 0,
      error,
    },
  ]);
  const { result } = renderHook(() => useDiagnosticsActions(health));
  await act(() => result.current.deliverReport('clipboard'));
  const report = vi.mocked(desktopClient.copyText).mock.calls[0]?.[0];
  expect(JSON.parse(report ?? '{}').failedProcessing).toEqual([
    expect.objectContaining({
      error: { code: error.code, message: error.message },
    }),
  ]);
});

it('does not report an export after the user cancels the save dialog', async () => {
  vi.mocked(desktopClient.saveTextFile).mockResolvedValue(false);
  const { result } = renderHook(() => useDiagnosticsActions(health));
  await act(() => result.current.deliverReport('file'));
  expect(notify).not.toHaveBeenCalled();
});

it.each(['clipboard', 'file'] as const)(
  'still reports an actual %s delivery failure',
  async (destination) => {
    vi.mocked(desktopClient.copyText).mockRejectedValue(
      new Error('Output unavailable'),
    );
    vi.mocked(desktopClient.saveTextFile).mockRejectedValue(
      new Error('Output unavailable'),
    );
    const { result } = renderHook(() => useDiagnosticsActions(health));
    await act(() => result.current.deliverReport(destination));
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      'Output unavailable',
      'error',
    );
  },
);
