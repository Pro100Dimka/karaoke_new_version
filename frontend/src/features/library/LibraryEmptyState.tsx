import { Beacon, Button, EmptyState, Stack } from "@ad-voice/ui";
import { useText } from "../../i18n/useText";

export type EmptyKind = "firstRun" | "noResults";

export const LibraryEmptyState = ({
  kind,
  onAddSong,
  onOpenAudioSettings,
  onOpenModels,
}: {
  kind: EmptyKind;
  onAddSong(): void;
  onOpenAudioSettings(): void;
  onOpenModels(): void;
}) => {
  const t = useText();
  if (kind === "noResults")
    return (
      <EmptyState
        className="libraryEmpty"
        icon="search"
        title={t("noResultsTitle")}
        description={t("noResultsBody")}
      />
    );
  return (
    <EmptyState
      className="libraryEmpty"
      icon="sparkle"
      title={t("firstSongTitle")}
      description={t("noSongsBody")}
      action={
        <Stack direction="row" gap={3} justify="center" wrap>
          <Beacon active>
            <Button size="lg" variant="primary" icon="plus" onClick={onAddSong}>
              {t("firstSongTitle")}
            </Button>
          </Beacon>
          <Button size="lg" icon="wave" onClick={onOpenAudioSettings}>
            {t("configureAudio")}
          </Button>
          <Button size="lg" icon="chip" onClick={onOpenModels}>
            {t("downloadRequiredModels")}
          </Button>
        </Stack>
      }
    />
  );
};
