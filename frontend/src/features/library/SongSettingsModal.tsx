import { AudioWaveform, FolderOpen, Piano, Save, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { routes } from "../../app/routes";
import type { SongDto, SongLanguage } from "../../contracts/models";
import type { SongPatch } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { FormStatus } from "../../shared/ui/FormStatus";
import { Modal } from "../../shared/ui/Modal";
import { Button, RenderFormikFields, useGetForm, type FormRow } from "../../theme/ui";
import { songStatusPresentation } from "./songPresentation";
import {
  loadSongPreferences,
  practiceSpeeds,
  saveSongPreferences,
  type VocalRange
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

const languages: readonly SongLanguage[] = ["Auto", "Ukrainian", "Russian", "English"];
const ranges = ["auto", "octave", "twoOctaves"] as const satisfies readonly VocalRange[];
const rangeLabel = { auto: "rangeAuto", octave: "rangeOctave", twoOctaves: "rangeTwoOctaves" } as const;

const SongSettingsForm = ({ song, onClose, onSave, onRemoveCover, onOpenFolder, onReprocess, onDelete }: { song: SongDto } & Omit<Props, "song">) => {
  const navigate = useNavigate();
  const t = useText();
  const status = songStatusPresentation[song.status];
  const coverState = t(song.coverState === "Custom" ? "coverCustom" : song.coverState === "Embedded" ? "coverEmbedded" : "coverFallback");
  const detected = detectedSongMetadata(song);

  const formik = useGetForm({
    initialValues: { title: song.title, artist: song.artist, language: song.language, coverPath: "", ...loadSongPreferences(song.id) },
    enableReinitialize: false,
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      try {
        const { title, artist, language, coverPath, ...local } = values;
        saveSongPreferences(song.id, local);
        await onSave(song, { title: title.trim() || undefined, artist: artist.trim() || undefined, language, coverPath: coverPath || undefined });
      } catch (failure) {
        helpers.setStatus(failure instanceof Error ? failure.message : String(failure));
      }
    }
  });

  const pickCover = async () => {
    const picked = await desktopClient.pickImageFile();
    if (picked) void formik.setFieldValue("coverPath", picked);
  };

  const fields: FormRow[] = [
    { tag: "title", label: t("title") },
    { tag: "artist", label: t("artist") },
    { type: "SelectField", tag: "language", label: t("songLanguage"), options: languages },
    { type: "FolderField", tag: "coverPath", label: t("coverArtwork"), placeholder: coverState, onBrowse: () => void pickCover(), browseLabel: t("replaceCover") },
    { tag: "videoUrl", label: t("videoUrl"), inputType: "url" },
    {
      type: "NumberField",
      tag: "defaultKey",
      label: t("defaultKey"),
      min: -12,
      max: 12,
      parse: raw => Math.max(-12, Math.min(12, Math.round(Number(raw) || 0)))
    },
    {
      type: "SelectField",
      tag: "defaultSpeed",
      label: t("defaultPracticeSpeed"),
      options: practiceSpeeds.map(speed => ({ value: speed, label: `${speed.toFixed(2)}×` }))
    },
    {
      type: "SelectField",
      tag: "vocalRange",
      label: t("defaultVocalRange"),
      options: ranges.map(item => ({ value: item, label: t(rangeLabel[item]) }))
    }
  ];
  const rows = fields.map(row => ({ md: 6, ...row }));

  return (
    <Modal open title={t("songSettings")} closeLabel={t("closeDialog")} onClose={onClose}>
      <form className="modalStack settingsForm" noValidate onSubmit={formik.handleSubmit}>
        <RenderFormikFields formik={formik} items={rows} />
        <dl className="importInfo">
          <div>{t("detectedTempo", { value: detected.bpm })}</div>
          <div>{t("detectedKey", { value: detected.key })}</div>
          <div>{t("projectFormatVersion", { value: song.projectFormatVersion })}</div>
          <div>{t("processingStatus", { value: t(status.label) })}</div>
        </dl>
        <FormStatus status={formik.status} />
        <div className="modalActions">
          {(song.detectedBpm !== undefined || song.detectedKey) && (
            <Button type="button" variant="outlined" tone="neutral" onClick={() => {
              void formik.setFieldValue("defaultKey", 0);
              void formik.setFieldValue("defaultSpeed", 1);
            }}>
              {t("useDetectedValue")}
            </Button>
          )}
          {song.coverState === "Custom" && (
            <Button type="button" variant="outlined" tone="neutral" onClick={() => void onRemoveCover(song)}>
              {t("removeCustomCover")}
            </Button>
          )}
          <Button type="button" variant="outlined" tone="neutral" startIcon={<Piano size={17} />} disabled={song.status !== "ready"} onClick={() => { onClose(); navigate(routes.editor(song.id)); }}>
            {t("melodyEditor")}
          </Button>
          <Button type="button" variant="outlined" tone="neutral" startIcon={<FolderOpen size={17} />} onClick={() => onOpenFolder(song)}>
            {t("openFolder")}
          </Button>
          <Button type="button" variant="outlined" tone="neutral" startIcon={<AudioWaveform size={17} />} disabled={song.status === "queued" || song.status === "processing"} onClick={() => onReprocess(song)}>
            {t("reprocess")}
          </Button>
          <Button type="button" variant="outlined" tone="neutral" startIcon={<Trash2 size={17} />} disabled={song.status === "queued" || song.status === "processing"} onClick={() => onDelete(song)}>
            {t("deleteSong")}
          </Button>
          <Button type="submit" startIcon={<Save size={17} />} disabled={formik.isSubmitting}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export const SongSettingsModal = ({ song, ...rest }: Props) => {
  if (!song) return null;
  return <SongSettingsForm key={song.id} song={song} {...rest} />;
};
