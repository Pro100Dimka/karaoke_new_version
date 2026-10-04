import { GlowText, ImageShine, NeonWaves, Sparkles, Stack, StatTile, Typography } from "@ad-voice/ui";
import { useApp } from "../../app/AppContext";
import { appThemes } from "../../app/appTheme";
import { useText } from "../../i18n/useText";
import { FriendsStat } from "../social/FriendsStat";

interface LibraryHeaderProps {
  titleId: string;
  songCount: number;
  readyCount: number;
}

export const LibraryHeader = ({ titleId, songCount, readyCount }: LibraryHeaderProps) => {
  const t = useText();
  const { preferences } = useApp();
  return (
    <header className="libraryHero">
      <div className="identity">
        <Sparkles count={12} className="identityMark">
          <ImageShine className="identityIcon" src={appThemes[preferences.theme].icon} />
        </Sparkles>
        <Stack gap={2}>
          <Typography variant="eyebrow" tone="accent">{t("yourMusicCollection")}</Typography>
          <Typography as="h1" id={titleId} variant="display"><GlowText flicker>A&amp;D Voice</GlowText></Typography>
          <Typography tone="muted">{t("libraryTagline")}</Typography>
        </Stack>
      </div>
      <StatTile icon="music" value={songCount} label={t("totalSongs")} />
      <StatTile icon="mic" value={readyCount} label={t("readyForKaraoke")} />
      <FriendsStat />
      <NeonWaves className="libraryHeroWaves" shape="ridge" comets={4} strands={28} phase={1.7} />
    </header>
  );
};
