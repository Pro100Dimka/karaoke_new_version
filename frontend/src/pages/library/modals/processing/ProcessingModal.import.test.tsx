import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessingJobDto, SongDto } from '../../../../contracts/models';
import { clearStorage } from '../../../../shared/storage/localStore';
import { ProcessingModal } from './index';

const fixture = vi.hoisted(() => ({
  songs: [] as SongDto[],
  imports: [] as SongDto[],
  jobs: [] as ProcessingJobDto[],
  cancelJob: vi.fn(async () => undefined),
  cancelProcessing: vi.fn(async () => undefined),
  retryProcessing: vi.fn(async () => true),
  resetLyricsAndReprocess: vi.fn(async () => true),
}));
vi.mock('@neo-ui-kit/react', () => {
  const Panel = ({
    children,
    title,
  }: {
    children?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      {title}
      {children}
    </section>
  );
  const Action = ({
    label,
    children,
    onClick,
    disabled,
  }: {
    label?: string;
    children?: ReactNode;
    onClick?(): void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {label ?? children}
    </button>
  );
  return {
    Card: Panel,
    Typography: Panel,
    Stack: Panel,
    MessageBar: Panel,
    Dialog: ({
      open,
      children,
      title,
      confirmLabel,
      onConfirm,
    }: {
      open: boolean;
      children?: ReactNode;
      title?: string;
      confirmLabel?: string | false;
      onConfirm?(): void;
    }) =>
      open ? (
        <section>
          {title}
          {children}
          {confirmLabel && <button onClick={onConfirm}>{confirmLabel}</button>}
        </section>
      ) : null,
    IconButton: Action,
    Button: Action,
    SplitButton: Action,
    StatusIndicator: () => null,
    Steps: () => null,
    Menu: () => null,
    NeonWaves: () => null,
    tr: (key: string) => key,
    useLocale: () => 'ru',
  };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useInfiniteQuery: () => ({ data: { pages: [{ items: fixture.songs }] } }),
  useQuery: () => ({ data: fixture.imports }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 150,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 150,
      })),
    measureElement: vi.fn(),
    options: { scrollMargin: 0 },
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock('../../../../providers/application', () => ({
  useJobs: () => ({ jobs: fixture.jobs, failed: false }),
}));
vi.mock('../../../../providers/store', () => ({
  store: {
    application: { localProcessing: false, services: { pythonEpoch: 0 } },
  },
}));
vi.mock('../../../../components/api-service', () => ({
  songsQuery: () => ({}),
  refreshSongs: vi.fn(),
}));
vi.mock('../../../../services/pythonClient', () => ({
  pythonClient: {
    cancelJob: fixture.cancelJob,
    cancelProcessing: fixture.cancelProcessing,
    diagnostics: async () => ({
      storage: {
        songs: 0,
        models: 0,
        cache: 0,
        recordings: 0,
        temp: 0,
        free: 100,
      },
    }),
  },
}));
vi.mock('../../songs/useGuardedAction', () => ({
  useGuardedAction: () => (work: () => unknown) => work(),
}));
vi.mock('../../songs/useSongActions', () => ({
  useSongActions: () => ({
    retryProcessing: fixture.retryProcessing,
    resetLyricsAndReprocess: fixture.resetLyricsAndReprocess,
    reportProcessingError: vi.fn(),
  }),
}));
vi.mock('./ProcessingError', () => ({
  ProcessingErrorDialog: ({
    open,
    onRetry,
    onResetLyrics,
  }: {
    open: boolean;
    onRetry?(): void;
    onResetLyrics?(): void;
  }) =>
    open ? (
      <section>
        {onRetry && <button onClick={onRetry}>Retry failed job</button>}
        {onResetLyrics && (
          <button onClick={onResetLyrics}>Reset lyrics after conflict</button>
        )}
      </section>
    ) : null,
  processingErrorText: () => '',
}));

const song: SongDto = {
  id: 'song',
  title: 'Selected song',
  artist: '',
  language: 'Auto',
  status: 'not-processed',
  durationSeconds: 30,
  createdAt: '',
  coverState: 'Fallback',
  activeRevision: 0,
  projectFormatVersion: 1,
};
const job: ProcessingJobDto = {
  id: 'import-job',
  type: 'SongImport',
  songId: '',
  state: 'processing',
  stage: 'Copying',
  progress: 45,
};
afterEach(() => {
  clearStorage();
  vi.clearAllMocks();
  fixture.songs = [];
  fixture.imports = [];
  fixture.jobs = [];
});

it.each(['queued', 'processing'] as const)(
  'confirms and cancels a %s import through the general job endpoint',
  async (state) => {
    fixture.imports = [
      { ...song, id: 'import:pending', status: 'importing', jobId: job.id },
    ];
    fixture.jobs = [{ ...job, state }];
    render(<ProcessingModal open onClose={vi.fn()} onPlay={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(fixture.cancelJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'processingStop' }));
    await waitFor(() =>
      expect(fixture.cancelJob).toHaveBeenCalledExactlyOnceWith(job.id),
    );
    expect(fixture.cancelProcessing).not.toHaveBeenCalled();
    expect(screen.getAllByText('Selected song')).toHaveLength(1);
  },
);

it('does not offer cancellation for a local placeholder with no backend job yet', () => {
  fixture.imports = [{ ...song, id: 'import:pending', status: 'importing' }];
  render(<ProcessingModal open onClose={vi.fn()} onPlay={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'cancel' })).toBeNull();
});

it.each(['not-processed', 'ready'] as const)(
  'offers playback after import only when the song is ready (%s)',
  (status) => {
    fixture.songs = [{ ...song, status }];
    fixture.jobs = [
      { ...job, songId: song.id, state: 'completed', progress: 100 },
    ];
    render(<ProcessingModal open onClose={vi.fn()} onPlay={vi.fn()} />);
    expect(Boolean(screen.queryByRole('button', { name: 'play' }))).toBe(
      status === 'ready',
    );
  },
);

it.each(['queued', 'processing'] as const)(
  'keeps the %s song-processing cancellation route that updates the song status',
  async (state) => {
    fixture.songs = [{ ...song, status: 'processing' }];
    fixture.jobs = [{ ...job, type: 'SongProcessing', songId: song.id, state }];
    render(<ProcessingModal open onClose={vi.fn()} onPlay={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'processingStop' }));
    await waitFor(() =>
      expect(fixture.cancelProcessing).toHaveBeenCalledExactlyOnceWith(job.id),
    );
    expect(fixture.cancelJob).not.toHaveBeenCalled();
  },
);

it('retries failed word alignment as word alignment', async () => {
  fixture.songs = [{ ...song, status: 'ready' }];
  fixture.jobs = [
    {
      ...job,
      type: 'SongProcessing',
      songId: song.id,
      state: 'failed',
      timingOperation: 'lyrics',
    },
  ];
  render(<ProcessingModal open onClose={vi.fn()} onPlay={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'viewError' }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry failed job' }));
  await waitFor(() =>
    expect(fixture.retryProcessing).toHaveBeenCalledExactlyOnceWith(
      song.id,
      'lyrics',
    ),
  );
});

it('connects a manual-lyrics conflict to the confirmed reset action', async () => {
  fixture.songs = [{ ...song, status: 'ready' }];
  fixture.jobs = [
    {
      ...job,
      type: 'SongProcessing',
      songId: song.id,
      state: 'failed',
      timingOperation: 'lyrics',
      error: {
        code: 'ManualLyricsConflict',
        message: 'Manual timing exists',
        source: 'python',
      },
    },
  ];
  render(<ProcessingModal open onClose={vi.fn()} onPlay={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'viewError' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Reset lyrics after conflict' }),
  );
  await waitFor(() =>
    expect(fixture.resetLyricsAndReprocess).toHaveBeenCalledExactlyOnceWith(
      song.id,
    ),
  );
  expect(fixture.retryProcessing).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: 'Reset lyrics after conflict' }),
  ).toBeNull();
});
