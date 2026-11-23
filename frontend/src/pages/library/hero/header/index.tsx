import { Grid } from '@neo-ui-kit/react';
import LibraryStats from './stats';
import LibraryTitle from './title';

const LibraryHeader = ({ onOpenProcessing }: { onOpenProcessing(): void }) => (
  <header data-window-drag>
    <Grid
      columns={{ base: 1, md: 2 }}
      gap={10}
      style={{ position: 'relative' }}
    >
      <Grid span={1} style={{ zIndex: 2 }}>
        <LibraryTitle />
      </Grid>
      <Grid span={1} style={{ display: 'flex', zIndex: 2 }}>
        <LibraryStats onOpenProcessing={onOpenProcessing} />
      </Grid>
    </Grid>
  </header>
);

export default LibraryHeader;
