import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../contracts/models';
import { store } from '../../../../providers/store';
import type { BackendRecording } from '../../../../services/pythonMappers';
import '../../../../providers/localization';
import { RecordingsModal } from './index';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => notify,
}));
// These tests exercise the ordinary archive, without playing audio or opening analysis.
vi.mock('./RecordingPlayer', () => ({ RecordingPlayer: () => null }));
vi.mock('../analysis', () => ({ PerformanceAnalysisModal: () => null }));

const song: SongDto = {
  id: 'song',
  title: 'Saved song',
  artist: 'Singer',
  language: 'Auto',
  status: 'ready',
  durationSeconds: 180,
  createdAt: '2026-11-20T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};
const recording: BackendRecording = {
  recordingId: 'take',
  songId: song.id,
  songRevision: 1,
  filePath: '/recordings/take.wav',
  displayName: 'Saved performance',
  createdAt: '2026-11-20T01:00:00Z',
  duration: 15,
  sampleRate: 48000,
  channels: 2,
  sizeBytes: 1000,
  fileStatus: 'Ready',
  analysisStatus: 'NotAnalyzed',
};
const page = (items: BackendRecording[]) => ({
  ok: true,
  status: 200,
  body: { items, total: items.length, offset: 0, limit: 200 },
});

let client: QueryClient;
const backendListeners = new Set<(event: unknown) => void>();
const request =
  vi.fn<(call: PythonBridgeRequest) => Promise<PythonBridgeResponse>>();

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
  backendListeners.clear();
  store.setLanguage('ru');
  store.returnFromKaraoke(null);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Keep the real HTTP client, DTO mapping and readBackendSnapshot behavior.
  Object.assign(window, {
    desktop: {
      pythonRequest: request,
      onBackendEvent: (listener: (event: unknown) => void) => {
        backendListeners.add(listener);
        return () => backendListeners.delete(listener);
      },
    },
  });
});

afterEach(() => {
  client.clear();
  Reflect.deleteProperty(window, 'desktop');
});

const Archive = () => {
  const [requested, setRequested] = useState<SongDto | null>(null);
  const handled = useCallback(() => setRequested(null), []);
  return (
    <QueryClientProvider client={client}>
      <button onClick={() => setRequested(song)}>Open archive</button>
      <RecordingsModal
        requestedSong={requested}
        onRequestHandled={handled}
        onAnalysisReady={() => undefined}
      />
    </QueryClientProvider>
  );
};

it('keeps a failed rename editable and retries the same name through the recording API', async () => {
  request
    .mockResolvedValueOnce(page([recording]))
    .mockRejectedValueOnce(new Error('Temporary write failure'))
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { ...recording, displayName: 'Retried performance name' },
    });
  render(<Archive />);
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
  fireEvent.click(
    await screen.findByRole('button', { name: tr('renameTake') }),
  );
  fireEvent.change(screen.getByRole('textbox', { name: tr('renameTake') }), {
    target: { value: 'Retried performance name' },
  });
  fireEvent.click(screen.getByRole('button', { name: tr('save') }));
  await waitFor(() => expect(notify).toHaveBeenCalledOnce());

  expect(screen.getByRole('textbox', { name: tr('renameTake') })).toHaveValue(
    'Retried performance name',
  );
  expect(screen.getByRole('button', { name: tr('save') })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: tr('save') }));
  await waitFor(() =>
    expect(
      screen.queryByRole('textbox', { name: tr('renameTake') }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole('button', { name: /Retried performance name/ }),
  ).toBeVisible();
  expect(
    request.mock.calls.filter(([call]) => call.method === 'PATCH'),
  ).toEqual([
    [
      {
        method: 'PATCH',
        path: '/recordings/take',
        body: { displayName: 'Retried performance name' },
      },
    ],
    [
      {
        method: 'PATCH',
        path: '/recordings/take',
        body: { displayName: 'Retried performance name' },
      },
    ],
  ]);
});

it('keeps the name editor pending and sends a repeated submit only once', async () => {
  let finish: (response: PythonBridgeResponse) => void = () => {};
  request.mockResolvedValueOnce(page([recording])).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<Archive />);
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
  fireEvent.click(
    await screen.findByRole('button', { name: tr('renameTake') }),
  );
  const input = screen.getByRole('textbox', { name: tr('renameTake') });
  fireEvent.change(input, { target: { value: 'Confirmed name' } });
  const form = input.closest('form');
  if (!form) throw new Error('Rename form was not rendered');
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });

  expect(
    screen.getByRole('textbox', { name: tr('renameTake') }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: tr('save') })).toBeDisabled();
  expect(
    request.mock.calls.filter(([call]) => call.method === 'PATCH'),
  ).toHaveLength(1);
  await act(async () =>
    finish({
      ok: true,
      status: 200,
      body: { ...recording, displayName: 'Confirmed name' },
    }),
  );
  expect(
    screen.queryByRole('textbox', { name: tr('renameTake') }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Confirmed name/ })).toBeVisible();
});

it('keeps a new rename draft after reopening when the previous save finishes late', async () => {
  let finish: (response: PythonBridgeResponse) => void = () => {};
  request
    .mockResolvedValueOnce(page([recording]))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(page([recording]));
  render(<Archive />);
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
  fireEvent.click(
    await screen.findByRole('button', { name: tr('renameTake') }),
  );
  fireEvent.change(screen.getByRole('textbox', { name: tr('renameTake') }), {
    target: { value: 'Earlier saved name' },
  });
  fireEvent.click(screen.getByRole('button', { name: tr('save') }));
  fireEvent.click(screen.getByRole('button', { name: tr('closeDialog') }));
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
  fireEvent.click(
    await screen.findByRole('button', { name: tr('renameTake') }),
  );
  fireEvent.change(screen.getByRole('textbox', { name: tr('renameTake') }), {
    target: { value: 'New unsaved name' },
  });
  await act(async () =>
    finish({
      ok: true,
      status: 200,
      body: { ...recording, displayName: 'Earlier saved name' },
    }),
  );

  expect(screen.getByRole('textbox', { name: tr('renameTake') })).toHaveValue(
    'New unsaved name',
  );
  expect(screen.getByRole('button', { name: tr('save') })).toBeEnabled();
});

it('does not describe a failed archive request as an empty recording collection', async () => {
  // BackendEndpoint.request rejects with this message while its process is stopped/starting.
  request.mockRejectedValueOnce(
    new Error('Python backend is starting or stopped'),
  );
  render(<Archive />);
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));

  await waitFor(() => expect(notify).toHaveBeenCalledOnce());

  expect(request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: 'GET',
      path: '/recordings?song_id=song&limit=200',
    }),
  );
  expect(screen.queryByText(tr('noRecordings'))).not.toBeInTheDocument();
  expect(screen.getByText(tr('errors.recordings'))).toBeVisible();
  expect(screen.getByRole('button', { name: tr('retry') })).toBeEnabled();
});

it('can retry loading the existing takes without closing the archive', async () => {
  let failRetry!: (error: Error) => void;
  let finish!: (response: PythonBridgeResponse) => void;
  request
    .mockRejectedValueOnce(new Error('Python backend is starting or stopped'))
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failRetry = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  render(<Archive />);
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
  const retry = await screen.findByRole('button', { name: tr('retry') });

  fireEvent.click(retry);

  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(tr('noRecordings'))).not.toBeInTheDocument();
  await act(async () => {
    failRetry(new Error('Python backend is starting or stopped'));
  });
  expect(screen.queryByText(tr('noRecordings'))).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: tr('retry') }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await act(async () => {
    finish(page([recording]));
  });
  expect(
    screen.getByRole('button', { name: /Saved performance/ }),
  ).toBeVisible();
  expect(screen.queryByText(tr('errors.recordings'))).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: tr('retry') }),
  ).not.toBeInTheDocument();

  request.mockResolvedValueOnce(
    page([{ ...recording, displayName: 'Updated performance' }]),
  );
  act(() => {
    for (const listener of [...backendListeners])
      listener({ type: 'recordings.changed' });
  });
  expect(
    await screen.findByRole('button', { name: /Updated performance/ }),
  ).toBeVisible();
});

it('ignores a late failure from a closed archive after it has been reopened', async () => {
  let failClosed!: (error: Error) => void;
  request
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failClosed = reject;
        }),
    )
    .mockResolvedValueOnce(page([recording]));
  render(<Archive />);
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: tr('closeDialog') }));
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
  expect(
    await screen.findByRole('button', { name: /Saved performance/ }),
  ).toBeVisible();

  await act(async () => {
    failClosed(new Error('Python backend is starting or stopped'));
  });

  expect(
    screen.getByRole('button', { name: /Saved performance/ }),
  ).toBeVisible();
  expect(screen.queryByText(tr('errors.recordings'))).not.toBeInTheDocument();
  expect(notify).not.toHaveBeenCalled();
});

it('still shows the empty state after a successful empty archive response', async () => {
  request.mockResolvedValueOnce(page([]));
  render(<Archive />);
  fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));

  expect(await screen.findByText(tr('noRecordings'))).toBeVisible();
  expect(screen.queryByText(tr('errors.recordings'))).not.toBeInTheDocument();
  expect(notify).not.toHaveBeenCalled();
});
