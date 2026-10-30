import { useLibraryImport } from "../modals/add-song/useLibraryImport";
import { observer } from "mobx-react-lite";
import { runInAction } from "mobx";
import { store } from "../../../providers/store";
import { useJobs } from "../../../providers/application";
import { Button, Stack, Switch, Tooltip, tr } from '@neo-ui-kit/react';
import { ru } from '../../../i18n/messages.ru';
import LibrarySearchField, { type LibraryFilters } from './search-field';
export type { LibraryFilters, StatusFilter } from './search-field';
interface LibraryActionsProps {
  roomRole?: "host" | "participant";
  collaborativeControl?: boolean;
  onCollaborativeControlChange(enabled: boolean): void;
  onOpenRoom(): void;
  onViewChange(query: string, filters: LibraryFilters): void;
}

export const LibraryActions = observer((props: LibraryActionsProps) => {
  const { roomRole, collaborativeControl = false } = props;
  const locked = roomRole === 'participant' && !collaborativeControl;
  const { addSong } = useLibraryImport();
  const { jobs } = useJobs();
  const activeJobs = jobs.filter(job => job.type === "SongProcessing" && ["queued", "processing", "cancelling"].includes(job.state)).length;
  const { query, filters: viewFilters } = store.library;
  const filters = { ...viewFilters, sort: store.preferences.librarySort, direction: store.preferences.librarySortDirection };
  const changeQuery = (value: string) => {
    if (locked) return;
    runInAction(() => { store.library.query = value; });
    props.onViewChange(value, filters);
  };
  const applyFilters = ({ sort, direction, ...next }: LibraryFilters) => {
    if (locked) return;
    runInAction(() => { store.library.filters = next; });
    store.updatePreferences({ librarySort: sort, librarySortDirection: direction });
    props.onViewChange(query, { ...next, sort, direction });
  };
  const openProcessing = () => runInAction(() => {
    store.libraryDialogs.focusSongId = undefined;
    store.libraryDialogs.processingOpen = true;
  });
  const actions = [
    { icon: "wave", label: tr(ru.processingQueue) + (activeJobs > 0 ? ` (${activeJobs})` : ""), onClick: openProcessing },
    ...(!roomRole ? [{ icon: "users", label: tr(ru.onlineRoom), onClick: props.onOpenRoom }] : []),
    { icon: "plus", label: tr(ru.addSong), onClick: () => void addSong(), variant: "primary" as const },
  ];
  return (
    <Stack role="toolbar" aria-label={tr(ru.library)} direction="row" align="center" wrap gap={3}
      style={{ position: 'sticky', top: 0, zIndex: 3, paddingBlock: 'var(--ad-space-3)' }}>
      <LibrarySearchField query={query} filters={filters} locked={locked}
        onQueryChange={changeQuery} onFiltersApply={applyFilters} />
      {actions.map((action) => <Button key={action.icon} size="lg" variant="secondary" {...action} />)}
      {roomRole === "host" && (
        <Tooltip content={tr(ru.collaborativeControlHint)}>
          <Switch
            size="lg"
            checked={collaborativeControl}
            label={tr(ru.collaborativeControl)}
            onValueChange={props.onCollaborativeControlChange}
          />
        </Tooltip>
      )}
    </Stack>
  );
});
