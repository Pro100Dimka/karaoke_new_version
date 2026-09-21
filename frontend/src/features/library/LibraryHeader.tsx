import { Mic2, Music2 } from "lucide-react";
import { useText } from "../../i18n/useText";
import { Typography } from "../../theme/ui";
import { StatCard } from "./StatCard";

interface LibraryHeaderProps {
  titleId: string;
  songCount: number;
  readyCount: number;
}

export const LibraryHeader = ({ titleId, songCount, readyCount }: LibraryHeaderProps) => {
  const t = useText();

  return (
    <header className="libraryHero">
      <div className="identity">
        <span className="identityIcon" aria-hidden />
        <div className="identityDetails">
          <Typography variant="body1" tone="muted">{t("yourMusicCollection")}</Typography>
          <Typography as="h1" id={titleId} variant="h1">A&amp;D Voice</Typography>
          <Typography variant="body1" tone="muted">{t("libraryTagline")}</Typography>
        </div>
      </div>
      <StatCard icon={Music2} value={songCount} label={t("totalSongs")} />
      <StatCard icon={Mic2} value={readyCount} label={t("readyForKaraoke")} />
    </header>
  );
};
