import { ArrowDown, ArrowUp, AudioWaveform, CircleCheck, Clock3, Image, Languages, Plus, Search, SlidersHorizontal, Sparkles, UsersRound } from "lucide-react";
import { useRef, useState } from "react";
import type { SongStatus } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { Button, IconButton, Popover, Select, Stack, Switch, TextField, Typography } from "../../theme/ui";
import type { LibrarySortDirection } from "../../shared/preferences/preferences";
import type { LibraryArtworkFilter, LibraryDurationFilter, LibraryLanguageFilter, LibrarySort } from "./librarySelectors";
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

const filterStatuses = ["ready", "importing", "processing", "queued", "not-processed", "failed", "invalid"] as const;
const statusOptions = [
  { value: "all", label: "allStatuses" },
  ...filterStatuses.map(status => ({ value: status, label: songStatusPresentation[status].label }))
] satisfies readonly { value: StatusFilter; label: MessageKey }[];

const sortOptions = [
  { value: "recent", label: "sortRecentlyAdded" },
  { value: "title", label: "titleSort" },
  { value: "artist", label: "artistSort" },
  { value: "played", label: "sortRecentlyPlayed" },
  { value: "duration", label: "sortDuration" },
  { value: "bpm", label: "sortBpm" },
] as const satisfies readonly { value: LibrarySort; label: MessageKey }[];

const languageOptions = ["all", "Auto", "Ukrainian", "Russian", "English"] as const;
const languageLabels = {
  all: "allLanguages",
  Auto: "languageAuto",
  Ukrainian: "languageUkrainian",
  Russian: "languageRussian",
  English: "languageEnglish",
} as const satisfies Record<LibraryLanguageFilter, MessageKey>;
const durationOptions = [
  { value: "all", label: "durationAll" },
  { value: "short", label: "durationShort" },
  { value: "medium", label: "durationMedium" },
  { value: "long", label: "durationLong" },
] as const satisfies readonly { value: LibraryDurationFilter; label: MessageKey }[];
const artworkOptions = [
  { value: "all", label: "artworkAll" },
  { value: "with", label: "artworkWith" },
  { value: "without", label: "artworkWithout" },
] as const satisfies readonly { value: LibraryArtworkFilter; label: MessageKey }[];

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

/** Search with an immediately applied, controlled filter and sorting panel. */
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
  onAddSong
}: LibraryActionsProps) => {
  const t = useText();
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const roomControlsLocked = roomRole === "participant" && !collaborativeControl;
  const updateFilters = (patch: Partial<LibraryFilters>) => onFiltersApply({ ...filters, ...patch });
  const DirectionIcon = filters.direction === "asc" ? ArrowUp : ArrowDown;

  return (
    <Stack direction="row" gap="var(--space-4)" align="center" wrap className="libraryActions" role="toolbar" aria-label={t("library")}>
      <TextField
        className="searchInput"
        size="lg"
        aria-label={t("search")}
        placeholder={t("search")}
        value={query}
        readOnly={roomControlsLocked}
        onChange={onQueryChange}
        start={<Search aria-hidden />}
        end={
          <IconButton
            ref={anchor}
            icon={SlidersHorizontal}
            size="lg"
            label={t("filtersAndSorting")}
            variant={open ? "contained" : "outlined"}
            disabled={roomControlsLocked}
            onClick={() => setOpen(value => !value)}
          />
        }
      />
      <Button size="lg" variant="outlined" tone="neutral" startIcon={<AudioWaveform />} onClick={onOpenProcessing}>
        {t("processingQueue")}
        {activeJobs > 0 ? ` (${activeJobs})` : ""}
      </Button>
      {!roomRole && (
        <Button size="lg" variant="outlined" tone="neutral" startIcon={<UsersRound />} onClick={onOpenRoom}>
          {t("onlineRoom")}
        </Button>
      )}
      {roomRole === "host" && (
        <Switch
          size="lg"
          variant="plain"
          checked={collaborativeControl}
          label={t("collaborativeControl")}
          aria-label={t("collaborativeControl")}
          tooltip={t("collaborativeControlHint")}
          onChange={enabled => onCollaborativeControlChange(enabled)}
        />
      )}
      <Button size="lg" startIcon={<Plus />} onClick={onAddSong}>
        {t("addSong")}
      </Button>

      <Popover className="libraryFilterPopover" open={open} anchorRef={anchor} placement="bottom-end" onClose={() => setOpen(false)}>
        <div className="libraryFilterPanel">
          <header className="libraryFilterHeader">
            <span className="libraryFilterHeaderIcon"><Sparkles aria-hidden /></span>
            <div>
              <Typography variant="body1">{t("filtersAndSorting")}</Typography>
              <Typography variant="body2" tone="muted">{t("filtersApplyInstantly")}</Typography>
            </div>
          </header>
          <section className="libraryFilterSection" aria-label={t("sorting")}>
            <div className="libraryFilterSectionHeader">
              <Typography tone="muted">{t("sorting")}</Typography>
              <Button
                className="librarySortDirection"
                size="sm"
                variant="outlined"
                startIcon={<DirectionIcon />}
                aria-label={t(filters.direction === "asc" ? "sortAscending" : "sortDescending")}
                onClick={() => updateFilters({ direction: filters.direction === "asc" ? "desc" : "asc" })}
              >
                {t(filters.direction === "asc" ? "sortAscending" : "sortDescending")}
              </Button>
            </div>
            <div className="librarySortGrid">
            {sortOptions.map(option => (
              <Button key={option.value} size="sm" variant={filters.sort === option.value ? "contained" : "outlined"} onClick={() => updateFilters({ sort: option.value })}>
                {t(option.label)}
              </Button>
            ))}
            </div>
          </section>
          <section className="libraryFilterSection" aria-label={t("filters")}>
            <Typography tone="muted">{t("filters")}</Typography>
            <div className="libraryFilterGrid">
              <Select<StatusFilter>
                label={t("statusFilter")}
                startIcon={<CircleCheck />}
                value={filters.status}
                options={statusOptions.map(option => ({ value: option.value, label: t(option.label) }))}
                onChange={status => updateFilters({ status })}
              />
              <Select<LibraryLanguageFilter>
                label={t("songLanguage")}
                startIcon={<Languages />}
                value={filters.language}
                options={languageOptions.map(value => ({ value, label: t(languageLabels[value]) }))}
                onChange={language => updateFilters({ language })}
              />
              <Select<LibraryDurationFilter>
                label={t("durationFilter")}
                startIcon={<Clock3 />}
                value={filters.duration}
                options={durationOptions.map(option => ({ value: option.value, label: t(option.label) }))}
                onChange={duration => updateFilters({ duration })}
              />
              <Select<LibraryArtworkFilter>
                label={t("artworkFilter")}
                startIcon={<Image />}
                value={filters.artwork}
                options={artworkOptions.map(option => ({ value: option.value, label: t(option.label) }))}
                onChange={artwork => updateFilters({ artwork })}
              />
            </div>
          </section>
        </div>
      </Popover>
    </Stack>
  );
};
