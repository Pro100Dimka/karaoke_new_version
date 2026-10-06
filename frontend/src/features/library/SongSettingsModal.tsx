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
  TextField,
  useForm,
} from "@ad-voice/ui";
import { routes } from "../../app/routes";
import type { SongDto, SongLanguage } from "../../contracts/models";
import type { SongPatch } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { songStatusPresentation } from "./songPresentation";
import {
  loadSongPreferences,
  practiceSpeeds,
  saveSongPreferences,
  type VocalRange,
} from "./songPreferences";
import { detectedSongMetadata } from "./songMetadataPresentation";

interface Props {
  song: SongDto | null;
  onClose(): void;
  onSave(song: SongDto, patch: SongPatch): Promise<void>;
  onRemoveCover(song: SongDto): Promise<void>;
  onOpenFolder(song: SongDto): void;
  onReprocess(song: SongDto): void;
  onDelete(song: SongDto): void;
}

const languages: readonly SongLanguage[] = [
  "Auto",
  "Ukrainian",
  "Russian",
  "English",
];
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
} as const;

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
  const status = songStatusPresentation[song.status];
  const coverState = t(
    song.coverState in coverLabel
      ? coverLabel[song.coverState as keyof typeof coverLabel]
      : "coverFallback",
  );
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
    const picked = await desktopClient.pickImageFile();
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
          <TextField
            name="title"
            label={t("title")}
            value={form.values.title}
            onValueChange={set("title")}
          />
          <TextField
            name="artist"
            label={t("artist")}
            value={form.values.artist}
            onValueChange={set("artist")}
          />
          <Select<SongLanguage>
            label={t("songLanguage")}
            value={form.values.language}
            options={[...languages]}
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
            options={practiceSpeeds.map((speed) => ({
              value: String(speed),
              label: `${speed.toFixed(2)}×`,
            }))}
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
        <KeyValueList
          items={[
            [t("detectedTempoLabel"), String(detected.bpm)],
            [t("detectedKeyLabel"), String(detected.key)],
            [t("projectFormatLabel"), String(song.projectFormatVersion)],
            [t("processingStatusLabel"), t(status.label)],
          ]}
        />
        {failure && <MessageBar tone="error">{failure}</MessageBar>}
        <div className="songSettingsActions">
          {(song.detectedBpm !== undefined || song.detectedKey) && (
            <Button
              size="sm"
              icon="reset"
              onClick={() => {
                form.setValue("defaultKey", 0);
                form.setValue("defaultSpeed", 1);
              }}
            >
              {t("useDetectedValue")}
            </Button>
          )}
          {song.coverState === "Custom" && (
            <Button
              size="sm"
              icon="photo"
              onClick={() => void onRemoveCover(song)}
            >
              {t("removeCustomCover")}
            </Button>
          )}
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
          <Button size="sm" icon="folder" onClick={() => onOpenFolder(song)}>
            {t("openFolder")}
          </Button>
          <Button
            size="sm"
            icon="wave"
            disabled={busy}
            onClick={() => onReprocess(song)}
          >
            {t("reprocess")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            disabled={busy}
            onClick={() => onDelete(song)}
          >
            {t("deleteSong")}
          </Button>
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
