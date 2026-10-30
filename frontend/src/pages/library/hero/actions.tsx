import { Button, Stack, Switch, Tooltip, tr } from '@neo-ui-kit/react';
import { ru } from '../../../i18n/messages.ru';
import LibrarySearchField, { type LibraryFilters } from './search-field';
export type { LibraryFilters, StatusFilter } from './search-field';
interface LibraryActionsProps {
  query: string;
  filters: LibraryFilters;
  activeJobs: number;
  roomRole?: "host" | "participant";
  collaborativeControl?: boolean;
  onCollaborativeControlChange(enabled: boolean): void;
  onQueryChange(value: string): void;
  onFiltersApply(filters: LibraryFilters): void;
  onOpenRoom(): void;
  onOpenProcessing(): void;
  onAddSong(): void;
}

export const LibraryActions = (props: LibraryActionsProps) => {
  const { roomRole, collaborativeControl = false } = props;
  const locked = roomRole === 'participant' && !collaborativeControl;
  const actions = [
    { icon: "wave", label: tr(ru.processingQueue) + (props.activeJobs > 0 ? ` (${props.activeJobs})` : ""), onClick: props.onOpenProcessing },
    ...(!roomRole ? [{ icon: "users", label: tr(ru.onlineRoom), onClick: props.onOpenRoom }] : []),
    { icon: "plus", label: tr(ru.addSong), onClick: props.onAddSong, variant: "primary" as const },
  ];
  return (
    <Stack role="toolbar" aria-label={tr(ru.library)} direction="row" align="center" wrap gap={3}
      style={{ position: 'sticky', top: 0, zIndex: 3, paddingBlock: 'var(--ad-space-3)' }}>
      <LibrarySearchField query={props.query} filters={props.filters} locked={locked}
        onQueryChange={props.onQueryChange} onFiltersApply={props.onFiltersApply} />
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
};
