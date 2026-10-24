import { useNavigate } from "react-router-dom";
import { useState } from "react";
import {
  Button,
  Dialog,
  Grid,
  IconButton,
  KeyValueList,
  MessageBar,
  NumberField,
  Select,
  SplitButton,
  TextField,
  useForm,
} from "@neo-ui-kit/react";
import { routes } from "../../shared/routes";
import type { SongDto, SongLanguage } from "../../contracts/models";
import type { SongPatch } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { useLibraryFiles } from "../../app/LibraryProvider";
import { songStatusPresentation } from "./songPresentation";
import {
  loadSongPreferences,
  practiceSpeeds,
  saveSongPreferences,
  type VocalRange,
} from "../../application/library/songPreferences";
import { detectedSongMetadata, languageLabels } from "./songMetadataPresentation";

interface Props {
  song: SongDto | null;
  onClose(): void;
  onSave(song: SongDto, patch: SongPatch): Promise<void>;
  onRemoveCover(song: SongDto): Promise<void>;
  onOpenFolder(song: SongDto): void;
  onReprocess(song: SongDto, mode?: "lyrics"): void;
  onDelete(song: SongDto): void;
}

const ranges = [
  "auto",
  "octave",
  "twoOctaves",
] as const satisfies readonly VocalRange[];
const rangeLabel = {
  auto: "rangeAuto",
  octave: "rangeOctave",
  twoOctaves: "rangeTwoOctaves",
} as const;
const coverLabel = {
  Custom: "coverCustom",
  Embedded: "coverEmbedded",
  Fallback: "coverFallback",
} as const;
const textFields = [
  { name: "title", label: "title" },
  { name: "artist", label: "artist" },
] as const;
const practiceSpeedOptions = practiceSpeeds.map((speed) => ({
  value: String(speed),
  label: `${speed.toFixed(2)}×`,
}));

const SongSettingsForm = ({
  song,
  onClose,
  onSave,
  onRemoveCover,
  onOpenFolder,
  onReprocess,
  onDelete,
}: { song: SongDto } & Omit<Props, "song">) => {
  const navigate = useNavigate();
  const t = useText();
  const files = useLibraryFiles();
  const status = songStatusPresentation[song.status];
  const coverState = t(song.artworkUrl && song.coverState === "Fallback" ? "coverOnline" : coverLabel[song.coverState]);
  const detected = detectedSongMetadata(song);
  const busy = song.status === "queued" || song.status === "processing";

  const [failure, setFailure] = useState<string>();
  const form = useForm({
    initialValues: {
      title: song.title,
      artist: song.artist,
      language: song.language,
      coverPath: "",
      ...loadSongPreferences(song.id),
    },
    reinitialize: false,
    onSubmit: async (values) => {
      setFailure(undefined);
      try {
        const { title, artist, language, coverPath, ...local } = values;
        saveSongPreferences(song.id, local);
        await onSave(song, {
          title: title.trim() || undefined,
          artist: artist.trim() || undefined,
          language,
          coverPath: coverPath || undefined,
        });
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      }
    },
  });
  const set = (field: string) => (value: unknown) =>
    form.setValue(field, value);
  const pickCover = async () => {
    const picked = await files.pickImageFile();
    if (picked) form.setValue("coverPath", picked);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="songSettingsDialog"
      width="large"
      icon="settings"
      title={t("songSettings")}
      description={`${song.artist} — ${song.title}`}
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      confirmLabel={false}
    >
      <form
        className="songSettingsForm"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <Grid minChildWidth="min(100%, 16rem)" gap={4} align="start">
          {textFields.map(({ name, label }) => (
            <TextField
              key={name}
              name={name}
              label={t(label)}
              value={form.values[name]}
              onValueChange={set(name)}
            />
          ))}
          <Select<SongLanguage>
            label={t("songLanguage")}
            value={form.values.language}
            options={Object.entries(languageLabels).map(([value, label]) => ({ value: value as SongLanguage, label: t(label) }))}
            onValueChange={set("language")}
          />
          <TextField
            label={t("coverArtwork")}
            readOnly
            value={form.values.coverPath}
            placeholder={coverState}
            endAdornment={
              <IconButton
                size="xs"
                variant="ghost"
                icon="photo"
                label={t("replaceCover")}
                onClick={() => void pickCover()}
              />
            }
          />
          <TextField
            name="videoUrl"
            type="url"
            label={t("videoUrl")}
            value={form.values.videoUrl}
            onValueChange={set("videoUrl")}
            placeholder={song.videoUrl}
            description={t(song.videoUrl ? "discoveredVideoHelp" : "videoOverrideHelp")}
          />
          <NumberField
            label={t("defaultKey")}
            min={-12}
            max={12}
            value={form.values.defaultKey}
            onValueChange={(value) =>
              set("defaultKey")(
                Math.max(-12, Math.min(12, Math.round(Number(value) || 0))),
              )
            }
          />
          <Select
            label={t("defaultPracticeSpeed")}
            value={String(form.values.defaultSpeed)}
            options={practiceSpeedOptions}
            onValueChange={(value) => set("defaultSpeed")(Number(value))}
          />
          <Select<VocalRange>
            label={t("defaultVocalRange")}
            value={form.values.vocalRange}
            options={ranges.map((item) => ({
              value: item,
              label: t(rangeLabel[item]),
            }))}
            onValueChange={set("vocalRange")}
          />
        </Grid>
        {song.artworkUrl && <img className="songSettingsCover" src={song.artworkUrl} alt={`${song.artist} — ${song.title}`} />}
        <KeyValueList
          items={[
            [t("detectedTempoLabel"), String(detected.bpm)],
            [t("detectedKeyLabel"), String(detected.key)],
            [t("projectFormatLabel"), String(song.projectFormatVersion)],
            [t("processingStatusLabel"), t(status.label)],
          ]}
        />
        {failure && <MessageBar tone="error">{failure}</MessageBar>}
        <MessageBar tone="info">{t("realignLyricsHelp")}</MessageBar>
        <div className="songSettingsActions">
          <Button
            size="sm"
            icon="note"
            disabled={song.status !== "ready"}
            onClick={() => {
              onClose();
              navigate(routes.editor(song.id));
            }}
          >
            {t("melodyEditor")}
          </Button>
          <Button size="sm" icon="wave" disabled={song.status !== "ready"}
            onClick={() => onReprocess(song, "lyrics")}>
            {t("realignLyrics")}
          </Button>
          <SplitButton size="sm" icon="folder" label={t("openFolder")} onClick={() => onOpenFolder(song)}
            items={[
              ...(song.detectedBpm !== undefined || song.detectedKey ? [{ id: "detected", label: t("useDetectedValue"),
                onSelect: () => { form.setValue("defaultKey", 0); form.setValue("defaultSpeed", 1); } }] : []),
              ...(song.coverState === "Custom" ? [{ id: "cover", label: t("removeCustomCover"), onSelect: () => void onRemoveCover(song) }] : []),
              { id: "separator", separator: true },
              { id: "delete", label: t("deleteSong"), icon: "trash", danger: true, disabled: busy, onSelect: () => onDelete(song) },
            ]}>
            {t("openFolder")}
          </SplitButton>
          <Button
            type="submit"
            variant="primary"
            icon="save"
            loading={form.submitting}
          >
            {t("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export const SongSettingsModal = ({ song, ...rest }: Props) => {
  if (!song) return null;
  return <SongSettingsForm key={song.id} song={song} {...rest} />;
};
