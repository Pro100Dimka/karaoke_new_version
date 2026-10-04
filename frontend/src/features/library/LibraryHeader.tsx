import { Typography } from "@ad-voice/ui";
import { useText } from "../../i18n/useText";
import { FriendsStat } from "../social/FriendsStat";
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
        <span className="identityIcon" aria-hidden="true" />
        <div className="identityDetails">
          <Typography variant="eyebrow" tone="accent">{t("yourMusicCollection")}</Typography>
          <Typography as="h1" id={titleId} variant="display">A&amp;D Voice</Typography>
          <Typography tone="muted">{t("libraryTagline")}</Typography>
        </div>
      </div>
      <StatCard icon="music" value={songCount} label={t("totalSongs")} />
      <StatCard icon="mic" value={readyCount} label={t("readyForKaraoke")} />
      <FriendsStat />
    </header>
  );
};
