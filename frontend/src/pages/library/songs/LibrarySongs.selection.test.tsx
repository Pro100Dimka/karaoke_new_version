import { fireEvent, render, screen } from '@testing-library/react';
import { tr } from '@neo-ui-kit/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { SongDto } from '../../../contracts/models';
import LibrarySongs from './index';

const state = vi.hoisted(() => ({ visible: true }));
const song = {
  id: 'song',
  title: 'Song',
  artist: 'Singer',
  status: 'ready',
} as SongDto;

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../providers/store', () => ({
  store: {
    playback: { returned: null },
    application: { localProcessing: false },
    online: { room: null },
  },
}));
vi.mock('../../../providers/application', () => ({
  useRoomLibraryCommands: () => null,
}));
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../components/api-service', () => ({ refreshSongs: vi.fn() }));
vi.mock('../../../services/pythonClient', () => ({ pythonClient: {} }));
vi.mock('../empty-library', () => ({
  LibraryEmptyState: () => <div>Empty results</div>,
}));
vi.mock('../modals/recordings', () => ({ RecordingsModal: () => null }));
vi.mock('../modals/settings', () => ({ openSettings: vi.fn() }));
vi.mock('../modals/song-settings', () => ({ SongSettingsModal: () => null }));
vi.mock('./useSongActions', () => ({ curtainMilliseconds: 400 }));
vi.mock('./useLibraryCatalog', () => ({
  useLibraryCatalog: () => ({
    catalog: { data: {}, isFetching: false, isPlaceholderData: false },
    summary: { data: { total: 1 } },
    client: {},
    localSongs: [song],
    songs: [song],
    visibleSongs: state.visible ? [song] : [],
    completeCatalog: true,
  }),
}));
vi.mock('./song-grid', () => ({
  VirtualGrid: ({
    items,
    renderItem,
  }: {
    items: SongDto[];
    renderItem(song: SongDto): ReactNode;
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.id}>{renderItem(item)}</div>
      ))}
    </div>
  ),
}));
vi.mock('./song-grid/song-card', () => ({
  SongCard: ({ selection }: { selection: { toggle(id: string): void } }) => (
    <button onClick={() => selection.toggle('song')}>Select song</button>
  ),
}));

it('keeps the selection controls available when a search hides every selected song', () => {
  state.visible = true;
  const props = {
    playlistsOpen: false,
    onClosePlaylists: vi.fn(),
    onReady: vi.fn(),
    view: {
      query: '',
      filters: {
        status: 'all',
        language: 'all',
        duration: 'all',
        artwork: 'all',
      } as const,
    },
    onOpenProcessing: vi.fn(),
    pageRef: { current: null },
    onPlay: vi.fn(),
    songSelection: () => undefined,
  };
  const view = render(<LibrarySongs {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select song' }));
  expect(
    screen.getByRole('button', { name: tr('cancel') }),
  ).toBeInTheDocument();

  state.visible = false;
  view.rerender(
    <LibrarySongs {...props} view={{ ...props.view, query: 'no matches' }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: tr('cancel') }));
  expect(
    screen.queryByRole('button', { name: tr('cancel') }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('Empty results')).toBeInTheDocument();
});
