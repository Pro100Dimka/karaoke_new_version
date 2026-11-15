import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '@neo-ui-kit/react';
import '../../../providers/localization';
import { SelectionToolbar } from './SelectionToolbar';
import type { SongDto } from '../../../contracts/models';

afterEach(cleanup);
it('allows playlist selection during processing while retaining deletion protection and translated counts', () => {
  setLocale('ru');
  const add = vi.fn(),
    remove = vi.fn();
  const select = vi.fn();
  const props = {
    selected: new Set(['one', 'two']),
    songs: [],
    disabled: false,
    deleting: false,
    onSelect: select,
    onDelete: remove,
    onAddToPlaylist: add,
    canDeleteSelected: true,
  };
  const view = render(<SelectionToolbar {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в плейлист' }));
  expect(add).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole('button', { name: 'Удалить выбранные (2)' }),
  );
  expect(remove).toHaveBeenCalledOnce();
  const songs: SongDto[] = (['queued', 'processing', 'importing'] as const).map(
    (status, index) => ({
      id: ['one', 'two', 'import:three'][index]!,
      title: status,
      artist: '',
      status,
      language: 'Auto',
      durationSeconds: 0,
      createdAt: '',
      coverState: 'Fallback',
      activeRevision: 0,
      projectFormatVersion: 1,
    }),
  );
  view.rerender(
    <SelectionToolbar {...props} songs={songs} canDeleteSelected={false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Добавить в плейлист' }));
  expect(add).toHaveBeenCalledTimes(2);
  const deleteButton = screen.getByRole('button', {
    name: 'Удалить выбранные (2)',
  });
  expect(deleteButton).toBeDisabled();
  fireEvent.click(deleteButton);
  expect(remove).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole('button', { name: 'Выбрать все показанные' }),
  );
  expect(select).toHaveBeenCalledWith(new Set(['one', 'two']));
});
