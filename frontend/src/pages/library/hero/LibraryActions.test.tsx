import { tr } from '@neo-ui-kit/react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import '../../../providers/localization';
import LibraryActions from './filters&actions/actions';

vi.mock('../../../providers/store', () => ({
  store: {
    preferences: {
      karaokePlaylists: [],
      librarySort: 'recent',
      librarySortDirection: 'desc',
    },
  },
}));
vi.mock('../modals/add-song/useLibraryImport', () => ({
  useLibraryImport: () => ({ addSong: vi.fn() }),
}));
vi.mock('./filters&actions/search-field', () => ({ default: () => <div /> }));

const renderActions = (roomRole?: 'host' | 'participant') =>
  render(
    <LibraryActions
      view={{
        query: '',
        filters: {
          status: 'all',
          language: 'all',
          duration: 'all',
          artwork: 'all',
        },
      }}
      onQueryChange={vi.fn()}
      onFiltersChange={vi.fn()}
      roomRole={roomRole}
      onCollaborativeControlChange={vi.fn()}
      onOpenRoom={vi.fn()}
      onOpenPlaylists={vi.fn()}
      playlistsDisabled={false}
      onViewChange={vi.fn()}
    />,
  );

it('keeps the library playlist button outside a room', () => {
  renderActions();
  expect(screen.getByRole('button', { name: tr('playlists') })).toBeVisible();
});

it.each(['host', 'participant'] as const)(
  'uses the room card as the only playlist entry for %s',
  (role) => {
    renderActions(role);
    expect(screen.queryByRole('button', { name: tr('playlists') })).toBeNull();
  },
);

