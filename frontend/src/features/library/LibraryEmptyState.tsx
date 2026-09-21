import { AudioWaveform, Cpu, Plus, Search, Sparkles } from "lucide-react";
import { useId } from "react";
import { useText } from "../../i18n/useText";
import { Button, Stack, Typography } from "../../theme/ui";

export type EmptyKind = "firstRun" | "noResults";

export const LibraryEmptyState = ({
  kind,
  onAddSong,
  onOpenAudioSettings,
  onOpenModels
}: {
  kind: EmptyKind;
  onAddSong(): void;
  onOpenAudioSettings(): void;
  onOpenModels(): void;
}) => {
  const t = useText();
  const titleId = useId();

  if (kind === "noResults") {
    return (
      <section className="emptyState" aria-labelledby={titleId}>
        <Search aria-hidden className="emptyStateIcon" />
        <Typography id={titleId} variant="h2">{t("noResultsTitle")}</Typography>
        <Typography variant="body2" tone="muted">{t("noResultsBody")}</Typography>
      </section>
    );
  }

  return (
    <section className="emptyState" aria-labelledby={titleId}>
      <Sparkles aria-hidden className="emptyStateIcon" />
      <Typography id={titleId} variant="h2">{t("firstSongTitle")}</Typography>
      <Typography variant="body2" tone="muted">{t("noSongsBody")}</Typography>
      <Stack direction="row" gap="var(--space-3)" justify="center" wrap>
        <Button size="lg" startIcon={<Plus />} onClick={onAddSong}>
          {t("firstSongTitle")}
        </Button>
        <Button size="lg" variant="outlined" tone="neutral" startIcon={<AudioWaveform />} onClick={onOpenAudioSettings}>
          {t("configureAudio")}
        </Button>
        <Button size="lg" variant="outlined" tone="neutral" startIcon={<Cpu />} onClick={onOpenModels}>
          {t("downloadRequiredModels")}
        </Button>
      </Stack>
    </section>
  );
};
