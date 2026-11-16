import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../contracts/models';
import { store } from '../../providers/store';
import { runInAction } from 'mobx';
import { AddToPlaylistDialog, PlaylistDialog } from './PlaylistDialog';
import '../../providers/localization';
import { clearStorage } from '../../shared/storage/localStore';

vi.mock('../../providers/notifications', () => ({ useNotify: () => vi.fn() }));
const songs: SongDto[] = ['one', 'two'].map((id) => ({
  id,
  title: id,
  artist: 'Singer',
  status: 'ready',
  activeRevision: 1,
  language: 'Auto',
  durationSeconds: 30,
  createdAt: '',
  coverState: 'Fallback',
  projectFormatVersion: 1,
}));
beforeEach(() => {
  store.setLanguage('ru');
  store.updatePreferences({ karaokePlaylists: [] });
});
afterEach(() => {
  cleanup();
  clearStorage();
  runInAction(() => {
    store.application.localProcessing = false;
  });
});

it('creates a playlist from selected cards during processing without a song picker', () => {
  runInAction(() => {
    store.application.localProcessing = true;
  });
  const added = vi.fn();
  render(
    <AddToPlaylistDialog
      songIds={['two', 'one']}
      onClose={vi.fn()}
      onAdded={added}
    />,
  );
  fireEvent.change(screen.getByLabelText('Название плейлиста'), {
    target: { value: 'Set' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Создать и добавить' }));
  expect(store.preferences.karaokePlaylists).toEqual([
    { id: expect.any(String), name: 'Set', songIds: ['two', 'one'] },
  ]);
  expect(added).toHaveBeenCalledOnce();
  expect(screen.queryByText('one')).not.toBeInTheDocument();
});

it('appends to an existing playlist while preserving order and avoiding duplicates', () => {
  store.updatePreferences({
    karaokePlaylists: [{ id: 'p', name: 'Set', songIds: ['one'] }],
  });
  render(
    <AddToPlaylistDialog
      songIds={['one', 'two']}
      onClose={vi.fn()}
      onAdded={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в плейлист' }));
  expect(store.preferences.karaokePlaylists[0]?.songIds).toEqual([
    'one',
    'two',
  ]);
});

it('does not create an unnamed playlist', () => {
  render(
    <AddToPlaylistDialog
      songIds={['one']}
      onClose={vi.fn()}
      onAdded={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Создать и добавить' }),
  ).toBeDisabled();
});

it('shows saved contents and starts them in their saved order without an add-song catalog', async () => {
  store.updatePreferences({
    karaokePlaylists: [{ id: 'p', name: 'Set', songIds: ['two', 'one'] }],
  });
  const play = vi.fn();
  render(<PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={play} />);
  expect(
    screen.queryByRole('button', { name: 'Добавить в плейлист' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Петь плейлист' }));
  expect(play).toHaveBeenCalledWith(
    { id: 'p', name: 'Set', songIds: ['two', 'one'] },
    [songs[1], songs[0]],
  );
});

it('blocks playback with a missing song instead of silently skipping it', () => {
  store.updatePreferences({
    karaokePlaylists: [{ id: 'p', name: 'Set', songIds: ['gone', 'one'] }],
  });
  render(<PlaylistDialog songs={songs} onClose={vi.fn()} onPlay={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Петь плейлист' })).toBeDisabled();
});

it('advances the local list once in order and stops at its end', () => {
  store.startPlaylist('Set', ['two', 'one']);
  expect(store.playback.launch).toEqual({ songId: 'two', mode: 'AutoStart' });
  expect(store.advancePlaylist('unrelated')).toBeUndefined();
  expect(store.advancePlaylist('two')).toBe('one');
  expect(store.advancePlaylist('two')).toBeUndefined();
  expect(store.advancePlaylist('one')).toBeUndefined();
  expect(store.playback.playlist).toBeNull();
  store.startPlaylist('Set', ['one']);
  store.cancelPlaylist();
  expect(store.playback.playlist).toBeNull();
});
