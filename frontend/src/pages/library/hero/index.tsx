import { Grid } from '@neo-ui-kit/react';
import LibraryStats from './stats';
import LibraryTitle from './title';

export const LibraryHeader = ({
  onOpenProcessing,
}: {
  onOpenProcessing(): void;
}) => (
  <header data-window-drag>
    <Grid columns={12} gap={10} style={{ position: 'relative' }}>
      {[
        { content: <LibraryTitle />, display: undefined },
        {
          content: <LibraryStats onOpenProcessing={onOpenProcessing} />,
          display: 'flex',
        },
      ].map(({ content, display }, index) => (
        <Grid
          key={index}
          span={{ base: 'full', md: 6, lg: 6, xl: 6 }}
          style={{ display, zIndex: 2 }}
        >
          {content}
        </Grid>
      ))}
    </Grid>
  </header>
);
