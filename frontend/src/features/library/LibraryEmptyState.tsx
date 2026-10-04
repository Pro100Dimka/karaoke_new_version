import { Button, EmptyState } from "@ad-voice/ui";
import { useText } from "../../i18n/useText";

export type EmptyKind = "firstRun" | "noResults";

export const LibraryEmptyState = ({ kind, onAddSong, onOpenAudioSettings, onOpenModels }: {
  kind: EmptyKind;
  onAddSong(): void;
  onOpenAudioSettings(): void;
  onOpenModels(): void;
}) => {
  const t = useText();
  if (kind === "noResults")
    return <EmptyState className="libraryEmpty" icon="search" title={t("noResultsTitle")} description={t("noResultsBody")} />;
  return (
    <EmptyState className="libraryEmpty" icon="sparkle" title={t("firstSongTitle")} description={t("noSongsBody")} action={
      <div className="libraryEmptyActions">
        <Button size="lg" variant="primary" icon="plus" onClick={onAddSong}>{t("firstSongTitle")}</Button>
        <Button size="lg" icon="wave" onClick={onOpenAudioSettings}>{t("configureAudio")}</Button>
        <Button size="lg" icon="chip" onClick={onOpenModels}>{t("downloadRequiredModels")}</Button>
      </div>
    } />
  );
};
