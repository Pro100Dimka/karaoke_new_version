import { Grid } from '@neo-ui-kit/react';
import LibraryStats from './stats';
import LibraryTitle from './title';

const LibraryHeader = ({ onOpenProcessing }: { onOpenProcessing(): void }) => (
  <header data-window-drag>
    <Grid columns={12} gap={10} style={{ position: 'relative' }}>
      <Grid span={{ base: 'full', md: 6, lg: 6, xl: 6 }} style={{ zIndex: 2 }}>
        <LibraryTitle />
      </Grid>
      <Grid
        span={{ base: 'full', md: 6, lg: 6, xl: 6 }}
        style={{ display: 'flex', zIndex: 2 }}
      >
        <LibraryStats onOpenProcessing={onOpenProcessing} />
      </Grid>
    </Grid>
  </header>
);

export default LibraryHeader;
