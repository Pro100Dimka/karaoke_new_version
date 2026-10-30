import { Grid } from '@neo-ui-kit/react';
import LibraryTitle from './title';
import LibraryStats from './stats';

const sections = [
  { Component: LibraryTitle, display: undefined },
  { Component: LibraryStats, display: 'flex' },
];

export const LibraryHeader = () => (
  <header data-window-drag>
    <Grid columns={{ base: 1, lg: 12 }} gap={10} style={{ position: 'relative' }}>
      {sections.map(({ Component, display }, index) => (
        <Grid key={index} span={{ base: 'full', lg: 6 }} style={{ display, zIndex: 2 }}>
          <Component />
        </Grid>
      ))}
    </Grid>
  </header>
);
