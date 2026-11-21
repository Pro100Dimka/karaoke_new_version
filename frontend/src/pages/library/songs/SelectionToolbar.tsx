import { Button, Stack, tr } from '@neo-ui-kit/react';
import type { SongDto } from '../../../contracts/models';

interface Props {
  selected: ReadonlySet<string>;
  songs: readonly SongDto[];
  disabled: boolean;
  deleting: boolean;
  onSelect(ids: ReadonlySet<string>): void;
  onDelete(): void;
  onAddToPlaylist(): void;
  deleteCount: number;
}

/** Batch-selection controls belong to the song list, not the library page. */
export const SelectionToolbar = ({
  selected,
  songs,
  disabled,
  deleting,
  onSelect,
  onDelete,
  onAddToPlaylist,
  deleteCount,
}: Props) => {
  const selectable = songs.filter(
    ({ roomOwnerId, status }) => !roomOwnerId && status !== 'importing',
  );
  return (
    <Stack direction="row" gap={2} wrap style={{ marginBottom: 16 }}>
      <Button
        icon="check"
        disabled={disabled || deleting}
        onClick={() => onSelect(new Set())}
      >
        {tr('cancel')}
      </Button>
      <Button
        disabled={disabled || deleting || selectable.length === 0}
        onClick={() => onSelect(new Set(selectable.map(({ id }) => id)))}
      >
        {tr('selectVisibleSongs')}
      </Button>
      <Button
        icon="list"
        disabled={disabled || deleting || selected.size === 0}
        onClick={onAddToPlaylist}
      >
        {tr('playlistAddTo')}
      </Button>
      <Button
        icon="trash"
        disabled={disabled || deleting || deleteCount === 0}
        onClick={onDelete}
      >
        {tr('deleteSelectedSongs', { count: deleteCount })}
      </Button>
    </Stack>
  );
};
