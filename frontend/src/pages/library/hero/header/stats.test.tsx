import { LocaleProvider, tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto } from '../../../../contracts/models';
import '../../../../providers/localization';
import LibraryStats from './stats';

const fixture = vi.hoisted(() => ({ jobs: [] as ProcessingJobDto[] }));
vi.mock('../../../../providers/application', () => ({
  useJobs: () => ({ jobs: fixture.jobs }),
}));
vi.mock('../../../../providers/store', () => ({
  store: {
    online: { room: null },
    application: { services: { pythonEpoch: 0 } },
  },
}));
vi.mock('../../../../services/pythonClient', () => ({
  pythonClient: {
    listSongs: vi.fn(async () => []),
    songSummary: vi.fn(async () => ({ total: 12, ready: 7, languages: [] })),
  },
}));
vi.mock('../../modals/friends', () => ({ FriendsDialog: () => null }));

const clients: QueryClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  fixture.jobs = [];
});

const job = (
  type: string,
  state: ProcessingJobDto['state'],
): ProcessingJobDto => ({
  id: `${type}-${state}`,
  type,
  songId: `${type}-${state}`,
  state,
  stage: 'Working',
  progress: 50,
});

const otherTasks = [
  job('ModelDownload', 'processing'),
  job('RecordingMastering', 'queued'),
  job('RecordingAnalysis', 'cancelling'),
  job('PackageExport', 'processing'),
  job('SongImport', 'completed'),
  job('SongProcessing', 'failed'),
  job('SongProcessing', 'cancelled'),
  job('SongProcessing', 'interrupted'),
];

const openStats = async (jobs: ProcessingJobDto[]) => {
  fixture.jobs = jobs;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryDefaults(['song-imports'], { queryFn: async () => [] });
  clients.push(client);
  const onOpenProcessing = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <LocaleProvider locale="ru">
        <LibraryStats onOpenProcessing={onOpenProcessing} />
      </LocaleProvider>
    </QueryClientProvider>,
  );
  const button = screen.getByRole('button', {
    name: `${tr('readyForKaraoke')} · ${tr('processingQueue')}`,
  });
  await waitFor(() => expect(within(button).getByText('7')).toBeVisible());
  return { button, onOpenProcessing };
};

it('does not advertise a song queue for model, recording or completed tasks', async () => {
  const { button, onOpenProcessing } = await openStats(otherTasks);

  expect(
    within(button).queryByLabelText(tr('processingQueue')),
  ).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(onOpenProcessing).toHaveBeenCalledOnce();
});

it('counts only waiting, running and cancelling song imports or processing', async () => {
  const { button } = await openStats([
    ...otherTasks,
    job('SongImport', 'queued'),
    job('SongProcessing', 'processing'),
    job('SongProcessing', 'cancelling'),
  ]);

  expect(
    within(button).getByLabelText(tr('processingQueue')),
  ).toHaveTextContent('3');
});
