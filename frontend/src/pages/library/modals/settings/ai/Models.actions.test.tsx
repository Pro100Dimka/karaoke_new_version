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
import { DialogView } from '../../../../../providers/dialog';
import '../../../../../providers/localization';
import {
  installBridge,
  type Call,
} from '../../../../../services/pythonClientFixture';
import type { AIModel, JobProgress } from '../../../../../utils/contracts';
import Models from './models';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../../providers/notifications', () => ({
  useNotify: () => notify,
}));

const model: AIModel = {
  modelId: 'asr-fixture',
  version: '1',
  purpose: 'ASR',
  state: 'Missing',
  size: 100,
  requiredDiskBytes: 1024,
};
const queued: JobProgress = {
  jobId: 'download-job',
  entityId: 'asr-fixture:1',
  state: 'Queued',
  stage: null,
  stageProgress: 0,
  overallProgress: 0,
};
let client: QueryClient;
let current: AIModel;
let job: JobProgress | null;
let deletionError: { code: string; message: string } | null;
let progressUnavailable: boolean;
let calls: Call[];
beforeEach(() => {
  vi.clearAllMocks();
  current = { ...model };
  job = null;
  deletionError = null;
  progressUnavailable = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = installBridge(({ method, path }) => {
    if (path === '/models' && method === 'GET')
      return { status: 200, ok: true, body: [current] };
    if (path === '/storage/free?area=models')
      return { status: 200, ok: true, body: 10_000 };
    if (path.startsWith('/jobs?'))
      return progressUnavailable
        ? {
            status: 503,
            ok: false,
            body: { code: 'Unavailable', message: 'Progress unavailable' },
          }
        : { status: 200, ok: true, body: { items: job ? [job] : [] } };
    if (path === '/jobs/download-job/cancel' && method === 'POST') {
      job = { ...queued, state: 'Cancelled' };
      return { status: 200, ok: true, body: job };
    }
    if (path === '/models/asr-fixture/1/download' && method === 'POST') {
      job = { ...queued };
      return {
        status: 202,
        ok: true,
        body: { jobId: job.jobId, state: job.state },
      };
    }
    if (path === '/models/asr-fixture/1' && method === 'DELETE') {
      if (deletionError) return { status: 409, ok: false, body: deletionError };
      current = { ...current, state: 'Missing' };
      return { status: 204, ok: true, body: null };
    }
    throw new Error(`Unexpected model request: ${method} ${path}`);
  });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'desktop');
});
const show = () =>
  render(
    <QueryClientProvider client={client}>
      <DialogView />
      <Models />
    </QueryClientProvider>,
  );
const downloadLabel = () => `${tr('modelDownload')} ${model.modelId}`;
const deleteLabel = () => `${tr('modelDelete')} ${model.modelId}`;

it.each(['Missing', 'Failed'] as const)(
  'shows and cancels a queued download while the model still reports %s, then permits retry',
  async (state) => {
    // DownloadModel sets model.state only when its queued worker actually starts.
    current = { ...current, state };
    job = { ...queued };
    show();
    const cancel = await screen.findByRole('button', { name: tr('cancel') });
    expect(
      screen.queryByRole('button', { name: downloadLabel() }),
    ).not.toBeInTheDocument();
    fireEvent.click(cancel);
    const retry = await screen.findByRole('button', { name: downloadLabel() });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await screen.findByRole('button', { name: tr('cancel') });
    expect(
      screen.queryByRole('button', { name: downloadLabel() }),
    ).not.toBeInTheDocument();
    expect(
      calls.filter(
        ({ method, path }) => method === 'POST' && path.endsWith('/download'),
      ),
    ).toHaveLength(1);
    expect(calls.filter(({ path }) => path.endsWith('/cancel'))).toHaveLength(
      1,
    );
  },
);

it.each([
  {
    code: 'ModelsInUse',
    message: 'Wait for background jobs to finish before deleting models',
    expectedKey: 'errorModelsInUse',
  },
  {
    code: 'ModelMissing',
    message: 'AI model was not found',
    expectedKey: null,
  },
])(
  'explains a $code model deletion failure and permits retry',
  async ({ code, message, expectedKey }) => {
    current = { ...current, state: 'Ready' };
    deletionError = { code, message };
    show();
    fireEvent.click(await screen.findByRole('button', { name: deleteLabel() }));
    const confirmation = await screen.findByRole('dialog', {
      name: tr('modelDelete'),
    });
    fireEvent.click(
      within(confirmation).getByRole('button', { name: tr('modelDelete') }),
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expectedKey ? tr(expectedKey) : message,
        'error',
      ),
    );
    expect(screen.getByText(tr('modelReady'))).toBeInTheDocument();
    deletionError = null;
    const retry = screen.getByRole('button', { name: deleteLabel() });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    const again = await screen.findByRole('dialog', {
      name: tr('modelDelete'),
    });
    fireEvent.click(
      within(again).getByRole('button', { name: tr('modelDelete') }),
    );
    await screen.findByRole('button', { name: downloadLabel() });
    expect(calls.filter(({ method }) => method === 'DELETE')).toHaveLength(2);
  },
);

it('offers retry instead of a duplicate download when queued-job lookup fails', async () => {
  job = { ...queued };
  progressUnavailable = true;
  show();
  const retry = await screen.findByRole('button', { name: tr('retry') });
  expect(screen.getByRole('button', { name: downloadLabel() })).toBeDisabled();
  progressUnavailable = false;
  fireEvent.click(retry);
  await screen.findByRole('button', { name: tr('cancel') });
  expect(
    calls.some(
      ({ method, path }) => method === 'POST' && path.endsWith('/download'),
    ),
  ).toBe(false);
});

it.each(['Downloading', 'Verifying'] as const)(
  'keeps cancellation available after a queued job enters %s',
  async (state) => {
    current = { ...current, state };
    job = {
      ...queued,
      state: 'Running',
      stage: state === 'Verifying' ? 'Verify' : 'Download',
      stageProgress: 0.25,
    };
    show();
    const cancel = await screen.findByRole('button', { name: tr('cancel') });
    expect(cancel).toBeEnabled();
    if (state === 'Downloading')
      expect(screen.getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '25',
      );
    else expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(calls.filter(({ path }) => path.endsWith('/cancel'))).toHaveLength(
        1,
      ),
    );
  },
);

it('reads an idle model job once without polling every second', async () => {
  vi.useFakeTimers();
  show();
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(screen.getByRole('button', { name: downloadLabel() })).toBeEnabled();
  const reads = calls.filter(({ path }) => path.startsWith('/jobs?')).length;
  expect(reads).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(calls.filter(({ path }) => path.startsWith('/jobs?'))).toHaveLength(
    reads,
  );
});

it('drops a stale job-lookup retry after the model becomes Ready', async () => {
  progressUnavailable = true;
  show();
  await screen.findByRole('button', { name: tr('retry') });
  current = { ...current, state: 'Ready' };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['models'] });
  });
  expect(await screen.findByText(tr('modelReady'))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: deleteLabel() })).toBeEnabled();
  expect(
    screen.queryByRole('button', { name: tr('retry') }),
  ).not.toBeInTheDocument();
});
