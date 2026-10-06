import { useRef, useState } from "react";
import {
  Button,
  Header,
  Icon,
  IconButton,
  Popover,
  Select,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  Tooltip,
  Typography,
} from "@ad-voice/ui";
import type { SongStatus } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import type { LibrarySortDirection } from "../../shared/preferences/preferences";
import type {
  LibraryArtworkFilter,
  LibraryDurationFilter,
  LibraryLanguageFilter,
  LibrarySort,
} from "./librarySelectors";
import { songStatusPresentation } from "./songPresentation";
import "./library-filters.css";

export type StatusFilter = SongStatus | "all";

export interface LibraryFilters {
  status: StatusFilter;
  language: LibraryLanguageFilter;
  duration: LibraryDurationFilter;
  artwork: LibraryArtworkFilter;
  sort: LibrarySort;
  direction: LibrarySortDirection;
}

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
  { value: "Auto", label: "languageAuto" },
  { value: "Ukrainian", label: "languageUkrainian" },
  { value: "Russian", label: "languageRussian" },
  { value: "English", label: "languageEnglish" },
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

/** Search with an immediately applied filter and sorting panel, the queue, the room and adding a song. */
export const LibraryActions = ({
  query,
  filters,
  activeJobs,
  roomRole,
  collaborativeControl = false,
  onCollaborativeControlChange,
  onQueryChange,
  onFiltersApply,
  onOpenRoom,
  onOpenProcessing,
  onAddSong,
}: LibraryActionsProps) => {
  const t = useText();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const roomControlsLocked =
    roomRole === "participant" && !collaborativeControl;
  const updateFilters = (patch: Partial<LibraryFilters>) =>
    onFiltersApply({ ...filters, ...patch });
  const ascending = filters.direction === "asc";
  const options = <V extends string>(
    list: readonly { value: V; label: MessageKey }[],
  ) => list.map((option) => ({ value: option.value, label: t(option.label) }));

  return (
    <div className="libraryActions" role="toolbar" aria-label={t("library")}>
      <TextField
        className="searchInput"
        size="lg"
        aria-label={t("search")}
        placeholder={t("search")}
        value={query}
        readOnly={roomControlsLocked}
        onValueChange={onQueryChange}
        startAdornment={<Icon name="search" />}
        endAdornment={
          <IconButton
            ref={anchor}
            size="sm"
            variant={open ? "primary" : "ghost"}
            icon="sliders"
            label={t("filtersAndSorting")}
            aria-expanded={open}
            disabled={roomControlsLocked}
            onClick={() => setOpen((value) => !value)}
          />
        }
      />
      <Button size="lg" icon="wave" onClick={onOpenProcessing}>
        {t("processingQueue")}
        {activeJobs > 0 ? ` (${activeJobs})` : ""}
      </Button>
      {!roomRole && (
        <Button size="lg" icon="users" onClick={onOpenRoom}>
          {t("onlineRoom")}
        </Button>
      )}
      {roomRole === "host" && (
        <Tooltip content={t("collaborativeControlHint")}>
          <Switch
            size="lg"
            checked={collaborativeControl}
            label={t("collaborativeControl")}
            onValueChange={onCollaborativeControlChange}
          />
        </Tooltip>
      )}
      <Button size="lg" variant="primary" icon="plus" onClick={onAddSong}>
        {t("addSong")}
      </Button>

      <Popover
        className="libraryFilterPopover"
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchor}
        align="end"
        label={t("filtersAndSorting")}
      >
        <div className="libraryFilterPanel">
          <Header
            icon="sparkle"
            level={4}
            title={t("filtersAndSorting")}
            description={t("filtersApplyInstantly")}
          />
          <section className="libraryFilterSection" aria-label={t("sorting")}>
            <Stack
              direction="row"
              gap={3}
              align="center"
              justify="between"
              wrap
            >
              <Typography variant="label" tone="muted">
                {t("sorting")}
              </Typography>
              <Button
                size="sm"
                icon={ascending ? "up" : "down"}
                onClick={() =>
                  updateFilters({ direction: ascending ? "desc" : "asc" })
                }
              >
                {t(ascending ? "sortAscending" : "sortDescending")}
              </Button>
            </Stack>
            <div className="librarySortGrid">
              {sortOptions.map((option) => (
                <ToggleButton
                  key={option.value}
                  size="sm"
                  checked={filters.sort === option.value}
                  onValueChange={() => updateFilters({ sort: option.value })}
                >
                  {t(option.label)}
                </ToggleButton>
              ))}
            </div>
          </section>
          <section className="libraryFilterSection" aria-label={t("filters")}>
            <Typography variant="label" tone="muted">
              {t("filters")}
            </Typography>
            <div className="libraryFilterGrid">
              <Select<StatusFilter>
                label={t("statusFilter")}
                icon="check"
                value={filters.status}
                options={options(statusOptions)}
                onValueChange={(status) => updateFilters({ status })}
              />
              <Select<LibraryLanguageFilter>
                label={t("songLanguage")}
                icon="studio"
                value={filters.language}
                options={options(languageOptions)}
                onValueChange={(language) => updateFilters({ language })}
              />
              <Select<LibraryDurationFilter>
                label={t("durationFilter")}
                icon="clock"
                value={filters.duration}
                options={options(durationOptions)}
                onValueChange={(duration) => updateFilters({ duration })}
              />
              <Select<LibraryArtworkFilter>
                label={t("artworkFilter")}
                icon="photo"
                value={filters.artwork}
                options={options(artworkOptions)}
                onValueChange={(artwork) => updateFilters({ artwork })}
              />
            </div>
          </section>
        </div>
      </Popover>
    </div>
  );
};
