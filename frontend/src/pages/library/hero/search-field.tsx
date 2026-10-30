import { useRef, useState } from "react";
import { Button, Grid, Icon, IconButton, Popover, Select, TextField, tr } from "@neo-ui-kit/react";
import type { SongStatus } from "../../../contracts/models";
import type { MessageKey } from "../../../i18n/messages";
import { ru } from "../../../i18n/messages.ru";
import type { LibrarySortDirection } from "../../../shared/preferences/preferences";
import type { LibraryArtworkFilter, LibraryDurationFilter, LibraryLanguageFilter, LibrarySort } from "../songs/librarySelectors";
import { languageLabels } from "../songs/songMetadataPresentation";
import { songStatusPresentation } from "../songs/songPresentation";
export type StatusFilter = SongStatus | "all";

export interface LibraryFilters {
  status: StatusFilter;
  language: LibraryLanguageFilter;
  duration: LibraryDurationFilter;
  artwork: LibraryArtworkFilter;
  sort: LibrarySort;
  direction: LibrarySortDirection;
}

export type LibraryViewFilters = Omit<LibraryFilters, "sort" | "direction">;

const filterStatuses = [
  "ready",
  "importing",
  "processing",
  "queued",
  "not-processed",
  "failed",
  "invalid",
] as const;
const statusOptions = [
  { value: "all", label: "allStatuses" },
  ...filterStatuses.map((status) => ({
    value: status,
    label: songStatusPresentation[status].label,
  })),
] satisfies readonly { value: StatusFilter; label: MessageKey }[];
const sortOptions = [
  { value: "recent", label: "sortRecentlyAdded" },
  { value: "title", label: "titleSort" },
  { value: "artist", label: "artistSort" },
  { value: "played", label: "sortRecentlyPlayed" },
  { value: "duration", label: "sortDuration" },
  { value: "bpm", label: "sortBpm" },
] as const satisfies readonly { value: LibrarySort; label: MessageKey }[];
const languageOptions = [
  { value: "all", label: "allLanguages" },
  ...Object.entries(languageLabels).map(([value, label]) => ({ value: value as Exclude<LibraryLanguageFilter, "all">, label })),
] as const satisfies readonly {
  value: LibraryLanguageFilter;
  label: MessageKey;
}[];
const durationOptions = [
  { value: "all", label: "durationAll" },
  { value: "short", label: "durationShort" },
  { value: "medium", label: "durationMedium" },
  { value: "long", label: "durationLong" },
] as const satisfies readonly {
  value: LibraryDurationFilter;
  label: MessageKey;
}[];
const artworkOptions = [
  { value: "all", label: "artworkAll" },
  { value: "with", label: "artworkWith" },
  { value: "without", label: "artworkWithout" },
] as const satisfies readonly {
  value: LibraryArtworkFilter;
  label: MessageKey;
}[];

const fields: {
  [K in keyof LibraryFilters]: {
    label: MessageKey;
    options: readonly { value: LibraryFilters[K]; label: MessageKey }[];
  }
} = {
  sort: { label: "sorting", options: sortOptions },
  direction: { label: "sorting", options: [
    { value: "asc", label: "sortAscending" },
    { value: "desc", label: "sortDescending" },
  ] },
  status: { label: "statusFilter", options: statusOptions },
  duration: { label: "durationFilter", options: durationOptions },
  artwork: { label: "artworkFilter", options: artworkOptions },
  language: { label: "songLanguage", options: languageOptions },
};


type SearchProps = { query: string; filters: LibraryFilters; locked: boolean;
  onQueryChange(value: string): void; onFiltersApply(filters: LibraryFilters): void };
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
      options={fields[key].options.map(({ value, label }) => ({ value, label: key === "language" && value !== "all" ? tr(ru[label]) : tr(`library.search.${value}`) }))}
      searchable={key === "language"}
      onValueChange={(value) => props.onFiltersApply({ ...filters, [key]: value })}
    />
  );
  return (<>
      <TextField
        style={{ flex: '1 1 20rem' }}
        maxLength={300}
        role="searchbox"
        size="lg"
        aria-label={tr(ru.search)}
        placeholder={tr("library.search.query")}
        readOnly={locked}
        clearable={!locked}
        value={query}
        onValueChange={props.onQueryChange}
        startAdornment={<Icon name="search" />}
        endAdornment={
          <IconButton
            ref={anchor}
            icon="sliders"
            variant={open ? "primary" : "ghost"}
            label={tr(ru.filtersAndSorting)}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={locked}
            onClick={() => setOpen(!open)}
          />
        }
      />
      <Popover open={open} onOpenChange={setOpen} anchorRef={anchor} align="end" label={tr(ru.filtersAndSorting)}>
        <Grid columns={{ base: 1, sm: 2 }} gap={3}>
          {open && (Object.keys(fields) as (keyof LibraryFilters)[]).map(select)}
          <Button variant="primary" size="sm" style={{ gridColumn: '1 / -1', width: '100%' }}
            label={tr('library.search.reset')} onClick={() => props.onFiltersApply({ status: 'all', language: 'all',
              duration: 'all', artwork: 'all', sort: 'recent', direction: 'desc' })} />
        </Grid>
      </Popover>
  </>);
}
