import { Dialog, tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
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

const RecordingsDialog = ({
  onRename,
}: {
  onRename(recording: RecordingDto, name: string): Promise<boolean>;
}) => {
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={client}>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={tr('recordings')}
        cancelLabel={false}
        confirmLabel={false}
      >
        <RecordingCard
          recording={recording}
          name={recording.displayName}
          index={0}
          onRename={onRename}
          onAnalyze={vi.fn()}
          onDelete={vi.fn()}
        />
      </Dialog>
    </QueryClientProvider>
  );
};

it('cancels an inline rename without allowing Escape to close the recordings dialog', () => {
  const rename = vi.fn();
  render(<RecordingsDialog onRename={rename} />);
  fireEvent.click(screen.getByRole('button', { name: tr('renameTake') }));
  const input = screen.getByRole('textbox', { name: tr('renameTake') });
  fireEvent.change(input, { target: { value: 'Discard this change' } });

  const defaultAllowed = fireEvent.keyDown(input, { key: 'Escape' });

  expect(
    screen.queryByRole('textbox', { name: tr('renameTake') }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(recording.displayName)).toBeInTheDocument();
  expect(rename).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: tr('recordings') })).toBeVisible();
  // jsdom does not perform native Escape dismissal; the key must cancel that default action.
  expect(defaultAllowed).toBe(false);
});

it('still saves the edited take name from the inline save button', async () => {
  const rename = vi.fn(async () => true);
  render(<RecordingsDialog onRename={rename} />);
  fireEvent.click(screen.getByRole('button', { name: tr('renameTake') }));
  fireEvent.change(screen.getByRole('textbox', { name: tr('renameTake') }), {
    target: { value: 'Saved name' },
  });

  fireEvent.click(screen.getByRole('button', { name: tr('save') }));

  expect(rename).toHaveBeenCalledExactlyOnceWith(recording, 'Saved name');
  await waitFor(() =>
    expect(
      screen.queryByRole('textbox', { name: tr('renameTake') }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('dialog', { name: tr('recordings') })).toBeVisible();
});

it('allows Escape to dismiss the dialog outside inline renaming', () => {
  render(<RecordingsDialog onRename={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: tr('recordings') });

  expect(fireEvent.keyDown(dialog, { key: 'Escape' })).toBe(true);
  // The browser emits cancel for an unhandled Escape; jsdom requires that native event explicitly.
  fireEvent(dialog, new Event('cancel', { cancelable: true }));

  expect(
    screen.queryByRole('dialog', { name: tr('recordings') }),
  ).not.toBeInTheDocument();
});

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
