import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mapSong } from '../../../../../services/pythonMappers';
import '../../../../../providers/localization';
import { SongCard } from './index';
import api from './processing-rejection.api-fixture.json';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../../providers/notifications', () => ({
  useNotify: () => notify,
}));

let client: QueryClient;
const request =
  vi.fn<(call: PythonBridgeRequest) => Promise<PythonBridgeResponse>>();
beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.assign(window, {
    desktop: {
      pythonRequest: request,
      onBackendEvent: () => () => undefined,
    },
  });
});
afterEach(() => {
  client.clear();
  Reflect.deleteProperty(window, 'desktop');
});

const card = (status = api.song.status) => (
  <QueryClientProvider client={client}>
    <SongCard
      song={mapSong({ ...api.song, status })}
      onPlay={vi.fn()}
      onOpenProcessing={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenRecordings={vi.fn()}
    />
  </QueryClientProvider>
);

it('can restart an imported song after a rejected preflight, without importing it again', async () => {
  // The fixture comes from real import -> POST processing (503 MissingRequiredModels)
  // -> GET song: the status remains Imported and no processing job was created.
  request.mockResolvedValueOnce({ ok: false, ...api.rejected });
  render(card());
  const retry = screen.getByRole('button', { name: tr('processingRetry') });

  fireEvent.click(retry);

  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.any(String), 'error'),
  );
  expect(retry).toBeEnabled();
  let finish!: (response: PythonBridgeResponse) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(retry);
  expect(retry).toBeDisabled();
  await act(async () => {
    finish({
      ok: true,
      status: 202,
      body: { jobId: 'queued-again', state: 'Queued' },
    });
  });

  expect(request).toHaveBeenCalledTimes(2);
  for (const [call] of request.mock.calls) {
    expect(call).toEqual(
      expect.objectContaining({
        method: 'POST',
        path: `/songs/${api.song.songId}/processing`,
        body: { mode: 'Auto', onlineLyrics: true },
        headers: { 'Idempotency-Key': expect.any(String) },
      }),
    );
  }
  expect(notify).toHaveBeenLastCalledWith(
    tr('processingRetryStarted'),
    'success',
  );
});

it('offers the same restart action for the Cancelled status returned by queued cancellation', () => {
  // CancelProcessing._update_song stores Cancelled; retain the real DTO mapping.
  render(card('Cancelled'));
  expect(
    screen.getByRole('button', { name: tr('processingRetry') }),
  ).toBeEnabled();
  expect(
    screen.queryByRole('button', { name: tr('play') }),
  ).not.toBeInTheDocument();
});

it.each(['Queued', 'Processing', 'Ready'])(
  'does not add a restart action to a %s card',
  (status) => {
    render(card(status));
    expect(
      screen.queryByRole('button', { name: tr('processingRetry') }),
    ).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  },
);

it.each(['dialog', 'card'])(
  'retries lyrics from the %s without changing the requested operation',
  async (entry) => {
    request.mockImplementation(async (call) => ({
      ok: true,
      status: 200,
      body:
        call.method === 'GET'
          ? {
              items: [
                {
                  jobId: 'lyrics-failed',
                  type: 'SongProcessing',
                  entityId: api.song.songId,
                  state: 'Failed',
                  stage: 'Alignment',
                  stageProgress: 0.5,
                  overallProgress: 0.8,
                  report: { timingOperation: 'lyrics' },
                  error: {
                    code: 'ProcessingTimeout',
                    message: 'Alignment timed out',
                  },
                },
              ],
              total: 1,
              limit: 200,
              offset: 0,
            }
          : { jobId: 'lyrics-retry', state: 'Queued' },
    }));
    render(card('Failed'));
    if (entry === 'dialog') {
      fireEvent.click(screen.getByRole('button', { name: tr('viewError') }));
      await screen.findAllByText(/Alignment timed out/);
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: tr('processingRetry'),
        }),
      );
    } else {
      fireEvent.click(
        screen.getByRole('button', { name: tr('processingRetry') }),
      );
    }
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: `/songs/${api.song.songId}/processing/lyrics`,
        }),
      ),
    );
  },
);
