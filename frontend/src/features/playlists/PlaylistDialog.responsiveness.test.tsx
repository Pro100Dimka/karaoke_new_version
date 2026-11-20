import { tr } from '@neo-ui-kit/react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { observable, runInAction } from 'mobx';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../contracts/models';
import '../../providers/localization';
import { store } from '../../providers/store';
import { clearStorage } from '../../shared/storage/localStore';
import { PlaylistDialog } from './PlaylistDialog';

const probe = vi.hoisted(() => ({ rowButtons: 0 }));
vi.mock('@neo-ui-kit/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@neo-ui-kit/react')>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      if (
        ['playlistMoveUp', 'playlistMoveDown', 'playlistRemove'].some(
          (key) => actual.tr(key) === props['aria-label'],
        )
      )
        probe.rowButtons++;
      return <actual.Button {...props} />;
    },
  };
});
vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));

type Song = Pick<
  SongDto,
  'id' | 'title' | 'artist' | 'status' | 'activeRevision'
>;
const catalog = (count: number): Song[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `song-${index}`,
    title: `Song ${index}`,
    artist: 'Singer',
    status: 'ready',
    activeRevision: 1,
  }));
const savePlaylist = (songs: readonly Song[]) =>
  store.updatePreferences({
    karaokePlaylists: [
      { id: 'list', name: 'Set', songIds: songs.map((song) => song.id) },
    ],
  });

beforeEach(() => {
  store.setLanguage('ru');
  probe.rowButtons = 0;
});
afterEach(() => {
  cleanup();
  clearStorage();
  store.updatePreferences({ karaokePlaylists: [] });
});

it('does not rebuild 1500 song action controls while typing a playlist name', () => {
  const songs = catalog(500);
  savePlaylist(songs);
  render(<PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={vi.fn()} />);
  expect(probe.rowButtons).toBe(1500);
  const input = screen.getByLabelText(tr('playlistName'));
  const value = 'After show';
  probe.rowButtons = 0;
  const start = performance.now();
  for (let length = 1; length <= value.length; length++) {
    fireEvent.change(input, { target: { value: value.slice(0, length) } });
  }
  console.info(
    JSON.stringify({
      scenario: 'playlist-500-name-10-keys',
      rowButtonRenders: probe.rowButtons,
      elapsedMs: performance.now() - start,
    }),
  );
  expect(input).toHaveValue(value);
  expect(probe.rowButtons).toBe(0);
});

it('keeps reorder focus, remove and saved order correct after editing the name', () => {
  const songs = catalog(3);
  savePlaylist(songs);
  const { container } = render(
    <PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={vi.fn()} />,
  );
  const first = container.querySelector<HTMLElement>('.playlistSong')!;
  const down = within(first).getByRole('button', {
    name: tr('playlistMoveDown'),
  });
  act(() => down.focus());
  fireEvent.click(down);
  expect(container.querySelectorAll('.playlistSong')[1]).toBe(first);
  expect(down).toHaveFocus();
  fireEvent.change(screen.getByLabelText(tr('playlistName')), {
    target: { value: 'Renamed' },
  });
  fireEvent.click(
    within(first).getByRole('button', { name: tr('playlistRemove') }),
  );
  fireEvent.click(screen.getByRole('button', { name: tr('save') }));
  expect(store.preferences.karaokePlaylists[0]).toEqual({
    id: 'list',
    name: 'Renamed',
    songIds: ['song-1', 'song-2'],
  });
  const rows = container.querySelectorAll<HTMLElement>('.playlistSong');
  expect(
    within(rows[0]!).getByRole('button', { name: tr('playlistMoveUp') }),
  ).toBeDisabled();
  expect(
    within(rows[1]!).getByRole('button', { name: tr('playlistMoveDown') }),
  ).toBeDisabled();
});

it('still refreshes song metadata and availability when the catalog changes', () => {
  const songs = catalog(2);
  savePlaylist(songs);
  const props = { onClose: vi.fn(), onPlay: vi.fn() };
  const view = render(<PlaylistDialog songs={songs} {...props} />);
  expect(
    screen.getByRole('button', { name: tr('playlistPlay') }),
  ).toBeEnabled();
  view.rerender(
    <PlaylistDialog
      songs={[
        { ...songs[0]!, title: 'Updated title', status: 'failed' },
        songs[1]!,
      ]}
      {...props}
    />,
  );
  expect(screen.getByText('Updated title')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: tr('playlistPlay') }),
  ).toBeDisabled();
  expect(screen.getByText('Updated title').closest('li')).toHaveAttribute(
    'data-unavailable',
    'true',
  );
});

it('keeps observing mutable song metadata while the name and list references stay the same', () => {
  const songs = observable(catalog(2));
  savePlaylist(songs);
  render(<PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={vi.fn()} />);
  act(() =>
    runInAction(() => {
      songs[0]!.title = 'Observable title';
      songs[0]!.status = 'failed';
    }),
  );
  expect(screen.getByText('Observable title')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: tr('playlistPlay') }),
  ).toBeDisabled();
  expect(screen.getByText('Observable title').closest('li')).toHaveAttribute(
    'data-unavailable',
    'true',
  );
});

it('locks the retained controls while playback starts and unlocks them after a failed start', async () => {
  const songs = catalog(3);
  savePlaylist(songs);
  let reject!: (reason: Error) => void;
  const play = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(<PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={play} />);
  fireEvent.click(screen.getByRole('button', { name: tr('playlistPlay') }));
  for (const button of screen.getAllByRole('button', {
    name: tr('playlistRemove'),
  }))
    expect(button).toBeDisabled();
  expect(screen.getByLabelText(tr('playlistName'))).toBeDisabled();
  await act(async () => reject(new Error('Playback unavailable')));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: tr('playlistPlay') }),
    ).toBeEnabled(),
  );
  for (const button of screen.getAllByRole('button', {
    name: tr('playlistRemove'),
  }))
    expect(button).toBeEnabled();
  expect(screen.getByLabelText(tr('playlistName'))).toBeEnabled();
});

it('updates same-reference observable catalog removals and replacements after a name edit', () => {
  const songs = observable(catalog(2));
  savePlaylist(songs);
  render(<PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(tr('playlistName')), {
    target: { value: 'Typed name' },
  });
  act(() =>
    runInAction(() => {
      songs.pop();
    }),
  );
  expect
    .soft(screen.getByRole('button', { name: tr('playlistPlay') }))
    .toBeDisabled();
  expect
    .soft(screen.queryByText(tr('playlistUnavailable')))
    .toBeInTheDocument();
  act(() =>
    runInAction(() => {
      songs.push({ ...catalog(2)[1]!, title: 'Replacement title' });
    }),
  );
  expect(
    screen.getByRole('button', { name: tr('playlistPlay') }),
  ).toBeEnabled();
  expect(screen.queryByText('Replacement title')).toBeInTheDocument();
});

it('uses the current order when the selected observable song ID array changes in place', async () => {
  const songs = catalog(2);
  const songIds = observable(songs.map((song) => song.id));
  store.updatePreferences({
    karaokePlaylists: [{ id: 'list', name: 'Set', songIds }],
  });
  const play = vi.fn();
  render(<PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={play} />);
  fireEvent.change(screen.getByLabelText(tr('playlistName')), {
    target: { value: 'Typed name' },
  });
  act(() =>
    runInAction(() => {
      songIds.reverse();
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: tr('playlistPlay') }));
  await waitFor(() =>
    expect(play).toHaveBeenCalledWith(
      { id: 'list', name: 'Typed name', songIds: ['song-1', 'song-0'] },
      [songs[1], songs[0]],
    ),
  );
});
