import { AudioWaveform, CircleCheck, Plus, Search, SlidersHorizontal, UsersRound } from "lucide-react";
import { useRef, useState } from "react";
import type { SongStatus } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { Button, IconButton, Popover, Select, Stack, TextField, Typography } from "../../theme/ui";
import type { LibrarySort } from "./librarySelectors";
import { songStatusPresentation } from "./songPresentation";

export type StatusFilter = SongStatus | "all";

export interface LibraryFilters {
  status: StatusFilter;
  sort: LibrarySort;
}

const defaultFilters: LibraryFilters = { status: "all", sort: "recent" };
const filterStatuses = ["ready", "processing", "queued", "not-processed", "failed", "invalid"] as const;
const statusOptions = [
  { value: "all", label: "allStatuses" },
  ...filterStatuses.map(status => ({ value: status, label: songStatusPresentation[status].label }))
] satisfies readonly { value: StatusFilter; label: MessageKey }[];

const sortOptions = [
  { value: "recent", label: "sortRecentlyAdded" },
  { value: "title", label: "titleSort" },
  { value: "artist", label: "artistSort" },
  { value: "played", label: "sortRecentlyPlayed" }
] as const satisfies readonly { value: LibrarySort; label: MessageKey }[];

interface LibraryActionsProps {
  query: string;
  filters: LibraryFilters;
  activeJobs: number;
  onQueryChange(value: string): void;
  onFiltersApply(filters: LibraryFilters): void;
  onOpenRoom(): void;
  onOpenProcessing(): void;
  onAddSong(): void;
}

/** Search with a filters popover (sorting + status, applied together) and the primary library actions. */
export const LibraryActions = ({
  query,
  filters,
  activeJobs,
  onQueryChange,
  onFiltersApply,
  onOpenRoom,
  onOpenProcessing,
  onAddSong
}: LibraryActionsProps) => {
  const t = useText();
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);

  const toggle = () => {
    if (!open) setDraft(filters);
    setOpen(value => !value);
  };
  const apply = () => {
    onFiltersApply(draft);
    setOpen(false);
  };

  return (
    <Stack direction="row" gap="var(--space-4)" align="center" wrap className="libraryActions" role="toolbar" aria-label={t("library")}>
      <TextField
        className="searchInput"
        size="lg"
        aria-label={t("search")}
        placeholder={t("search")}
        value={query}
        onChange={onQueryChange}
        start={<Search aria-hidden />}
        end={
          <IconButton
            ref={anchor}
            icon={SlidersHorizontal}
            size="sm"
            label={t("filtersAndSorting")}
            variant={open ? "contained" : "outlined"}
            onClick={toggle}
          />
        }
      />
      <Button size="lg" variant="outlined" tone="neutral" startIcon={<AudioWaveform />} onClick={onOpenProcessing}>
        {t("processingQueue")}
        {activeJobs > 0 ? ` (${activeJobs})` : ""}
      </Button>
      <Button size="lg" variant="outlined" tone="neutral" startIcon={<UsersRound />} onClick={onOpenRoom}>
        {t("onlineRoom")}
      </Button>
      <Button size="lg" startIcon={<Plus />} onClick={onAddSong}>
        {t("addSong")}
      </Button>

      <Popover open={open} anchorRef={anchor} placement="bottom-end" onClose={() => setOpen(false)}>
        <Stack gap="var(--space-4)">
          <Typography tone="muted">{t("sorting")}</Typography>
          <Stack direction="row" gap="var(--space-2)" wrap>
            {sortOptions.map(option => (
              <Button key={option.value} variant={draft.sort === option.value ? "contained" : "outlined"} onClick={() => setDraft({ ...draft, sort: option.value })}>
                {t(option.label)}
              </Button>
            ))}
          </Stack>
          <Select<StatusFilter>
            label={t("statusFilter")}
            startIcon={<CircleCheck />}
            value={draft.status}
            options={statusOptions.map(option => ({ value: option.value, label: t(option.label) }))}
            onChange={status => setDraft({ ...draft, status })}
          />
          <Stack direction="row" gap="var(--space-2)">
            <Button fullWidth onClick={apply}>
              {t("apply")}
            </Button>
            <Button fullWidth variant="outlined" onClick={() => setDraft(defaultFilters)}>
              {t("resetFilters")}
            </Button>
          </Stack>
        </Stack>
      </Popover>
    </Stack>
  );
};
