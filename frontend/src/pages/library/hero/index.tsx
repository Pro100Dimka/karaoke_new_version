import { Grid } from '@neo-ui-kit/react';
import type { useRoomLibrary } from '../songs/useRoomLibrary';
import LibraryActions from './filters&actions/actions';
import type { LibraryView } from './filters&actions/useLibraryView';
import type { LibraryViewFilters } from './filters&actions/search-field';
import LibraryHeader from './header';

type Props = {
  view: LibraryView;
  setQuery(query: string): void;
  setViewFilters(update: (current: LibraryViewFilters) => LibraryViewFilters): void;
  roomLibrary: ReturnType<typeof useRoomLibrary>;
  openProcessing(): void;
  setRoomOpen(open: boolean): void;
};

const Hero = ({
  view, setQuery, setViewFilters, roomLibrary,
  openProcessing, setRoomOpen,
}: Props) => (
  <Grid columns={12} gap={10} style={{ position: 'relative' }}>
    <Grid span={{ base: 'full' }} style={{ zIndex: 2 }}>
      <LibraryHeader onOpenProcessing={openProcessing} />
    </Grid>
    <Grid span={{ base: 'full' }}>
      <LibraryActions
        view={view}
        onQueryChange={setQuery}
        onFiltersChange={(filters) => setViewFilters(() => filters)}
        roomRole={roomLibrary.room?.role}
        collaborativeControl={roomLibrary.room?.collaborativeControl}
        onCollaborativeControlChange={roomLibrary.setCollaborativeControl}
        onOpenRoom={() => setRoomOpen(true)}
        onViewChange={roomLibrary.publishView}
      />
    </Grid>
  </Grid>
);

export default Hero;
