import { Grid } from '@neo-ui-kit/react';
import LibraryTitle from './title';
import LibraryStats from './stats';

export const LibraryHeader = ({
  onOpenProcessing,
}: {
  onOpenProcessing(): void;
}) => (
  <header data-window-drag>
    <Grid
      columns={{ base: 1, lg: 12 }}
      gap={10}
      style={{ position: 'relative' }}
    >
      {[
        { content: <LibraryTitle />, display: undefined },
        {
          content: <LibraryStats onOpenProcessing={onOpenProcessing} />,
          display: 'flex',
        },
      ].map(({ content, display }, index) => (
        <Grid
          key={index}
          span={{ base: 'full', lg: 6 }}
          style={{ display, zIndex: 2 }}
        >
          {content}
        </Grid>
      ))}
    </Grid>
  </header>
);
