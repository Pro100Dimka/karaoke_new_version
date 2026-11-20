import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RecordingDto } from '../../../../contracts/models';
import { desktopClient } from '../../../../services/desktopClient';
import { pythonClient } from '../../../../services/pythonClient';
import { RecordingCard } from './RecordingCard';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => notify,
}));
vi.mock('../../../../services/desktopClient', () => ({
  desktopClient: { revealInExplorer: vi.fn() },
}));
vi.mock('../../../../services/pythonClient', () => ({
  pythonClient: { getRecording: vi.fn(), latestAnalysis: vi.fn() },
}));
vi.mock('../../../../shared/hooks/useNearView', () => ({
  useNearView: () => false,
}));
vi.mock('./RecordingPlayer', () => ({ RecordingPlayer: () => null }));

const recording: RecordingDto = {
  id: 'take',
  songId: 'song',
  filePath: '/recordings/old-location.wav',
  displayName: 'My performance',
  createdAt: '2026-11-20T00:00:00Z',
  durationSeconds: 10,
  sizeBytes: 100,
  analyzed: false,
  fileStatus: 'Ready',
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(pythonClient.getRecording).mockResolvedValue({
    ...recording,
    filePath: '/recordings/current-location.wav',
  });
  vi.mocked(desktopClient.revealInExplorer).mockResolvedValue(undefined);
});
afterEach(() => client.clear());

it.each(['lookup', 'Explorer'] as const)(
  'reports a failed %s when opening a recording folder and allows retry',
  async (failure) => {
    const operation =
      failure === 'lookup'
        ? pythonClient.getRecording
        : desktopClient.revealInExplorer;
    vi.mocked(operation).mockRejectedValueOnce(
      new Error('Recording is unavailable'),
    );
    render(
      <QueryClientProvider client={client}>
        <RecordingCard
          recording={recording}
          name={recording.displayName}
          index={0}
          onRename={vi.fn()}
          onAnalyze={vi.fn()}
          onDelete={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: tr('openFolder') }));

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(tr('actionFailed'), 'error'),
    );
    if (failure === 'lookup')
      expect(desktopClient.revealInExplorer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: tr('openFolder') }));
    await waitFor(() =>
      expect(desktopClient.revealInExplorer).toHaveBeenCalledTimes(
        failure === 'lookup' ? 1 : 2,
      ),
    );
    expect(desktopClient.revealInExplorer).toHaveBeenLastCalledWith(
      '/recordings/current-location.wav',
    );
    expect(notify).toHaveBeenCalledOnce();
  },
);
