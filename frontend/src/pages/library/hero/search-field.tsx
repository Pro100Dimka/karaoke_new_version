import { useRef, useState } from 'react';
import {
  Button,
  Grid,
  Icon,
  IconButton,
  Popover,
  Select,
  TextField,
  tr,
} from '@neo-ui-kit/react';
import type { SongStatus } from '../../../contracts/models';
import { ru } from '../../../i18n/messages.ru';
import type { LibrarySortDirection } from '../../../shared/preferences/preferences';
import type {
  LibraryArtworkFilter,
  LibraryDurationFilter,
  LibraryLanguageFilter,
  LibrarySort,
} from '../songs/librarySelectors';
import { languageLabels } from '../songs/songMetadataPresentation';
export type StatusFilter = SongStatus | 'all';

export interface LibraryFilters {
  status: StatusFilter;
  language: LibraryLanguageFilter;
  duration: LibraryDurationFilter;
  artwork: LibraryArtworkFilter;
  sort: LibrarySort;
  direction: LibrarySortDirection;
}

export type LibraryViewFilters = Omit<LibraryFilters, 'sort' | 'direction'>;

const fields: { [K in keyof LibraryFilters]: readonly LibraryFilters[K][] } = {
  sort: ['recent', 'title', 'artist', 'played', 'duration', 'bpm'],
  direction: ['asc', 'desc'],
  status: [
    'all',
    'ready',
    'importing',
    'processing',
    'queued',
    'not-processed',
    'failed',
    'invalid',
  ],
  duration: ['all', 'short', 'medium', 'long'],
  artwork: ['all', 'with', 'without'],
  language: ['all', 'Auto', 'Ukrainian', 'Russian', 'English'],
};
const languageNames = new Map(Object.entries(languageLabels));

type SearchProps = {
  query: string;
  filters: LibraryFilters;
  locked: boolean;
  onQueryChange(value: string): void;
  onFiltersApply(filters: LibraryFilters): void;
};
export default function LibrarySearchField(props: SearchProps) {
  const { query, filters, locked } = props;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (locked && open) setOpen(false);
  const select = <K extends keyof LibraryFilters>(key: K) => (
    <Select<LibraryFilters[K]>
      key={key}
      label={tr(`library.search.${key}`)}
      value={filters[key]}
      options={fields[key].map((value) => {
        const label = key === 'language' ? languageNames.get(value) : undefined;
        return {
          value,
          label: label ? tr(ru[label]) : tr(`library.search.${value}`),
        };
      })}
      searchable={key === 'language'}
      onValueChange={(value) =>
        props.onFiltersApply({ ...filters, [key]: value })
      }
    />
  );
  return (
    <>
      <TextField
        style={{ flex: '1 1 20rem' }}
        maxLength={300}
        role="searchbox"
        size="lg"
        aria-label={tr(ru.search)}
        placeholder={tr('library.search.query')}
        readOnly={locked}
        clearable={!locked}
        value={query}
        onValueChange={props.onQueryChange}
        startAdornment={<Icon name="search" />}
        endAdornment={
          <IconButton
            ref={anchor}
            icon="sliders"
            variant={open ? 'primary' : 'ghost'}
            label={tr(ru.filtersAndSorting)}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={locked}
            onClick={() => setOpen(!open)}
          />
        }
      />
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchor}
        align="end"
        label={tr(ru.filtersAndSorting)}
      >
        <Grid columns={{ base: 1, sm: 2 }} gap={3}>
          {open &&
            (Object.keys(fields) as (keyof LibraryFilters)[]).map(select)}
          <Button
            variant="primary"
            size="sm"
            style={{ gridColumn: '1 / -1', width: '100%' }}
            label={tr('library.search.reset')}
            onClick={() =>
              props.onFiltersApply({
                status: 'all',
                language: 'all',
                duration: 'all',
                artwork: 'all',
                sort: 'recent',
                direction: 'desc',
              })
            }
          />
        </Grid>
      </Popover>
    </>
  );
}
