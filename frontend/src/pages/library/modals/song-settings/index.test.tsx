import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../contracts/models';
import { pythonClient } from '../../../../services/pythonClient';
import { desktopClient } from '../../../../services/desktopClient';
import { SongSettingsModal } from './index';
import { refreshSongs } from '../../../../components/api-service';

const actions = vi.hoisted(() => ({
  confirmDelete: vi.fn(),
  retryProcessing: vi.fn(async () => true),
  retrying: null as string | null,
  notify: vi.fn(),
}));
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../../services/pythonClient', () => ({
  pythonClient: { updateSong: vi.fn(), removeSongCover: vi.fn() },
}));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => actions.notify,
}));
vi.mock('../../songs/useSongActions', () => ({
  useSongActions: () => actions,
}));
vi.mock('../../../editor/editorApi', () => ({
  editorApi: {
    load: vi.fn(async () => ({ revision: 7, words: [], notes: [] })),
  },
}));
vi.mock('../../../../components/api-service', () => ({
  refreshSongs: vi.fn(async () => undefined),
}));

const song: SongDto = {
  id: 'song',
  title: 'Song title',
  artist: 'Incorrect artist',
  language: 'Auto',
  status: 'not-processed',
  durationSeconds: 180,
  createdAt: '2026-11-19T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 0,
  projectFormatVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  actions.retrying = null;
  vi.mocked(pythonClient.updateSong).mockResolvedValue(song);
});
afterEach(() => vi.restoreAllMocks());

it.each([0, 7])(
  'reports a failed Open folder for revision %s and permits retry without closing settings',
  async (activeRevision) => {
    const reveal = vi
      .spyOn(desktopClient, 'revealProject')
      .mockRejectedValueOnce(new Error('Folder is unavailable'))
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SongSettingsModal
          song={{ ...song, activeRevision }}
          onClose={onClose}
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: tr('title') }), {
      target: { value: 'Unsaved title' },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('openFolder') }));

    await waitFor(() =>
      expect(actions.notify).toHaveBeenCalledExactlyOnceWith(
        tr('actionFailed'),
        'error',
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: tr('title') })).toHaveValue(
      'Unsaved title',
    );
    fireEvent.click(screen.getByRole('button', { name: tr('openFolder') }));
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(2));
    expect(reveal).toHaveBeenLastCalledWith(song.id, activeRevision);
    expect(pythonClient.updateSong).not.toHaveBeenCalled();
    client.clear();
  },
);

it.each(['ready', 'processing', 'not-processed'] as const)(
  'offers words-and-notes refinement only for a ready project (%s)',
  async (status) => {
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SongSettingsModal
          song={{ ...song, status }}
          onClose={onClose}
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const refine = screen.getByRole('button', { name: tr('realignLyrics') });
    if (status === 'ready') {
      expect(refine).toBeEnabled();
      fireEvent.click(refine);
      await waitFor(() =>
        expect(actions.retryProcessing).toHaveBeenCalledWith(song.id, 'lyrics'),
      );
      expect(onClose).not.toHaveBeenCalled();
    } else {
      expect(refine).toBeDisabled();
      fireEvent.click(refine);
      expect(actions.retryProcessing).not.toHaveBeenCalled();
    }
  },
);

it.each(['', '   '])(
  'saves an explicitly cleared artist (%j)',
  async (artist) => {
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SongSettingsModal song={song} onClose={onClose} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: tr('artist') }), {
      target: { value: artist },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('save') }));
    await waitFor(() =>
      expect(pythonClient.updateSong).toHaveBeenCalledWith(
        song.id,
        expect.objectContaining({ title: undefined, artist: '' }),
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  },
);

it.each(['save', 'remove cover'] as const)(
  'keeps the next song settings open when %s from the closed dialog finishes',
  async (action) => {
    let complete!: (saved: SongDto) => void;
    const pending = new Promise<SongDto>((resolve) => {
      complete = resolve;
    });
    const operation =
      action === 'save'
        ? pythonClient.updateSong
        : pythonClient.removeSongCover;
    vi.mocked(operation).mockReturnValueOnce(pending);
    const firstSong: SongDto = { ...song, coverState: 'Custom' };
    const nextSong = { ...song, id: 'next-song', title: 'Next song title' };
    const Dialogs = () => {
      const [current, setCurrent] = useState<SongDto | null>(firstSong);
      return (
        <>
          <button onClick={() => setCurrent(nextSong)}>Open next song</button>
          {current && (
            <SongSettingsModal
              key={current.id}
              song={current}
              onClose={() => setCurrent(null)}
              onChange={setCurrent}
            />
          )}
        </>
      );
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Dialogs />
      </QueryClientProvider>,
    );
    if (action === 'save')
      fireEvent.click(screen.getByRole('button', { name: tr('save') }));
    else {
      fireEvent.click(
        screen.getByRole('button', { name: tr('Другие действия') }),
      );
      fireEvent.click(
        screen.getByRole('menuitem', { name: tr('removeCustomCover') }),
      );
    }
    await waitFor(() => expect(operation).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: tr('closeDialog') }));
    fireEvent.click(screen.getByRole('button', { name: 'Open next song' }));
    expect(screen.getByRole('textbox', { name: tr('title') })).toHaveValue(
      nextSong.title,
    );

    await act(async () => {
      complete(song);
    });

    expect(refreshSongs).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: tr('title') })).toHaveValue(
      nextSong.title,
    );
  },
);

it('updates the current song dialog when its cover removal finishes', async () => {
  const onChange = vi.fn();
  vi.mocked(pythonClient.removeSongCover).mockResolvedValueOnce(song);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SongSettingsModal
        song={{ ...song, coverState: 'Custom' }}
        onClose={vi.fn()}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: tr('Другие действия') }));
  fireEvent.click(
    screen.getByRole('menuitem', { name: tr('removeCustomCover') }),
  );

  await waitFor(() => expect(onChange).toHaveBeenCalledWith(song));
  expect(refreshSongs).toHaveBeenCalledOnce();
});

it.each([
  ['InvalidMedia', 'Select an MP4 video', 'errorInvalidMedia'],
  ['ClipMissing', 'Selected video file was not found', null],
] as const)(
  'explains a rejected settings save (%s), retains edits and permits retry',
  async (code, message, translation) => {
    vi.mocked(pythonClient.updateSong).mockRejectedValueOnce({
      code,
      message,
      source: 'python',
    });
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SongSettingsModal song={song} onClose={onClose} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    const title = screen.getByRole('textbox', { name: tr('title') });
    fireEvent.change(title, { target: { value: 'Edited title' } });
    fireEvent.click(screen.getByRole('button', { name: tr('save') }));

    await waitFor(() =>
      expect(
        screen.getByText(translation ? tr(translation) : message),
      ).toBeVisible(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(title).toHaveValue('Edited title');

    fireEvent.click(screen.getByRole('button', { name: tr('save') }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(pythonClient.updateSong).toHaveBeenLastCalledWith(
      song.id,
      expect.objectContaining({ title: 'Edited title' }),
    );
    client.clear();
  },
);
