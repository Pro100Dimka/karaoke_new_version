import type { useRoomLibrary } from '../songs/useRoomLibrary';
import LibraryActions from './filters&actions/actions';
import type { LibraryView } from './filters&actions/useLibraryView';
import type { LibraryViewFilters } from './filters&actions/search-field';
import LibraryHeader from './header';

type Props = {
  view: LibraryView;
  setQuery(query: string): void;
  setViewFilters(
    update: (current: LibraryViewFilters) => LibraryViewFilters,
  ): void;
  roomLibrary: ReturnType<typeof useRoomLibrary>;
  openProcessing(): void;
  onOpenRoom(): void;
  onOpenPlaylists(): void;
  playlistsDisabled: boolean;
};

const Hero = ({
  view,
  setQuery,
  setViewFilters,
  roomLibrary,
  openProcessing,
  onOpenRoom,
  onOpenPlaylists,
  playlistsDisabled,
}: Props) => (
  <>
    <div
      style={{
        position: 'relative',
        zIndex: 2,
        marginBottom: 'calc(var(--ad-space-10) - var(--ad-space-4))',
      }}
    >
      <LibraryHeader onOpenProcessing={openProcessing} />
    </div>
    <LibraryActions
      view={view}
      onQueryChange={setQuery}
      onFiltersChange={(filters) => setViewFilters(() => filters)}
      roomRole={roomLibrary.room?.role}
      collaborativeControl={roomLibrary.room?.collaborativeControl}
      onCollaborativeControlChange={roomLibrary.setCollaborativeControl}
      onOpenRoom={onOpenRoom}
      onOpenPlaylists={onOpenPlaylists}
      playlistsDisabled={playlistsDisabled}
      onViewChange={roomLibrary.publishView}
    />
  </>
);

export default Hero;
