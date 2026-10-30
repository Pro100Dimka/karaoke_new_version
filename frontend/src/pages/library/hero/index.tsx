import { Grid } from '@neo-ui-kit/react';
import LibraryTitle from './title';
import LibraryStats from './stats';

export const LibraryHeader = ({ titleId, songCount, readyCount }: {
  titleId: string; songCount: number | string; readyCount: number | string;
}) => (
  <header data-window-drag>
    <Grid columns={{ base: 1, lg: 12 }} gap={10} style={{ position: 'relative' }}>
      <Grid span={{ base: 'full', lg: 6 }} style={{ zIndex: 2 }}>
        <LibraryTitle titleId={titleId} />
      </Grid>
      <Grid span={{ base: 'full', lg: 6 }} style={{ display: 'flex', zIndex: 2 }}>
        <LibraryStats songCount={songCount} readyCount={readyCount} />
      </Grid>
    </Grid>
  </header>
);
