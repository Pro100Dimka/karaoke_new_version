import { Button, Stack, tr } from '@neo-ui-kit/react';
import type { SongDto } from '../../../contracts/models';

interface Props {
  selected: ReadonlySet<string>;
  songs: readonly SongDto[];
  disabled: boolean;
  deleting: boolean;
  onSelect(ids: ReadonlySet<string>): void;
  onDelete(): void;
}

/** Batch-selection controls belong to the song list, not the library page. */
export const SelectionToolbar = ({
  selected,
  songs,
  disabled,
  deleting,
  onSelect,
  onDelete,
}: Props) => (
  <Stack direction="row" gap={2} wrap style={{ marginBottom: 16 }}>
    <Button
      icon="check"
      disabled={disabled || deleting}
      onClick={() => onSelect(new Set())}
    >
      {tr('cancel')}
    </Button>
    <Button
      disabled={disabled || deleting}
      onClick={() =>
        onSelect(
          new Set(
            songs
              .filter(
                ({ roomOwnerId, status }) =>
                  !roomOwnerId &&
                  status !== 'queued' &&
                  status !== 'processing',
              )
              .map(({ id }) => id),
          ),
        )
      }
    >
      {tr('selectVisibleSongs')}
    </Button>
    <Button
      icon="trash"
      disabled={disabled || deleting || selected.size === 0}
      onClick={onDelete}
    >
      {tr('deleteSelected ({count})', { count: selected.size })}
    </Button>
  </Stack>
);
