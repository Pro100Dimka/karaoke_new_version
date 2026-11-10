import { Button, Stack, Switch, Tooltip, tr } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { store } from '../../../../providers/store';
import { useLibraryImport } from '../../modals/add-song/useLibraryImport';
import LibrarySearchField, {
  type LibraryFilters,
  type LibraryViewFilters,
} from './search-field';
export type { LibraryFilters, StatusFilter } from './search-field';
interface LibraryActionsProps {
  view: { query: string; filters: LibraryViewFilters };
  onQueryChange(query: string): void;
  onFiltersChange(filters: LibraryViewFilters): void;
  roomRole?: 'host' | 'participant';
  collaborativeControl?: boolean;
  onCollaborativeControlChange(enabled: boolean): void;
  onOpenRoom(): void;
  onViewChange(query: string, filters: LibraryFilters): void;
}

const LibraryActions = observer((props: LibraryActionsProps) => {
  const { roomRole, collaborativeControl = false } = props;
  const locked = roomRole === 'participant' && !collaborativeControl;
  const { addSong } = useLibraryImport();
  const { query, filters: viewFilters } = props.view;
  const filters = {
    ...viewFilters,
    sort: store.preferences.librarySort,
    direction: store.preferences.librarySortDirection,
  };
  const changeQuery = (value: string) => {
    if (locked) return;
    props.onQueryChange(value);
    props.onViewChange(value, filters);
  };
  const applyFilters = ({ sort, direction, ...next }: LibraryFilters) => {
    if (locked) return;
    props.onFiltersChange(next);
    store.updatePreferences({
      librarySort: sort,
      librarySortDirection: direction,
    });
    props.onViewChange(query, { ...next, sort, direction });
  };
  const actions = [
    ...(!roomRole
      ? [{ icon: 'users', label: tr('onlineRoom'), onClick: props.onOpenRoom }]
      : []),
    {
      icon: 'plus',
      label: tr('addSong'),
      onClick: () => void addSong(),
      variant: 'primary' as const,
    },
  ];
  return (
    <Stack
      role="toolbar"
      aria-label={tr('library')}
      direction="row"
      align="center"
      wrap
      gap={3}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 3,
        paddingBlock: 'var(--ad-space-3)',
      }}
    >
      <LibrarySearchField
        query={query}
        filters={filters}
        locked={locked}
        onQueryChange={changeQuery}
        onFiltersApply={applyFilters}
      />
      {actions.map((action) => (
        <Button key={action.icon} size="lg" variant="secondary" {...action} />
      ))}
      {roomRole === 'host' && (
        <Tooltip content={tr('collaborativeControlHint')}>
          <Switch
            size="lg"
            checked={collaborativeControl}
            label={tr('collaborativeControl')}
            onValueChange={props.onCollaborativeControlChange}
          />
        </Tooltip>
      )}
    </Stack>
  );
});
export default LibraryActions;
