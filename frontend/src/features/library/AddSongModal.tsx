import { Music2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ImportMetadata } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { Alert } from "../../shared/ui/Alert";
import { FormStatus } from "../../shared/ui/FormStatus";
import { Modal } from "../../shared/ui/Modal";
import { Button, RenderFormikFields, useGetForm, type FormRow } from "../../theme/ui";
import { formatBytes } from "../../shared/utils/format";
import { guessMetadata, isSupportedAudio } from "./importModel";

interface AddSongModalProps {
  open: boolean;
  initialPath?: string;
  onClose(): void;
  onImport(path: string, metadata: ImportMetadata): Promise<void>;
}

/** Only what the user changed is sent, so untouched fields keep the better detection from the file's own tags. */
const changedMetadata = (values: { title: string; artist: string }, detected: { title: string; artist: string } | null): ImportMetadata => {
  const title = values.title.trim();
  const artist = values.artist.trim();
  return {
    title: title && title !== detected?.title ? title : undefined,
    artist: artist && artist !== detected?.artist ? artist : undefined
  };
};

type FileState =
  | { kind: "none" }
  | { kind: "ready"; info: FileInfo }
  | { kind: "unsupported"; info: FileInfo }
  | { kind: "unreadable" };

export const AddSongModal = ({ open, initialPath = "", onClose, onImport }: AddSongModalProps) => {
  const t = useText();
  const [file, setFile] = useState<FileState>({ kind: "none" });

  const formik = useGetForm({
    initialValues: { path: initialPath, title: "", artist: "" },
    enableReinitialize: false,
    validate: () => (file.kind === "ready" ? {} : { path: t("chooseAudioFirst") }),
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      try {
        await onImport(values.path, changedMetadata(values, detected));
        helpers.resetForm({ values: { path: "", title: "", artist: "" } });
        onClose();
      } catch (failure) {
        const key = errorMessageKey(toAppError(failure));
        helpers.setStatus(key ? t(key) : t("importFailed"));
      }
    }
  });
  const { path } = formik.values;
  const { resetForm, setFieldValue } = formik;
  const detected = file.kind === "ready" ? guessMetadata(file.info.name) : null;

  useEffect(() => {
    if (open) resetForm({ values: { path: initialPath, title: "", artist: "" } });
  }, [open, initialPath, resetForm]);

  useEffect(() => {
    if (!path) {
      setFile({ kind: "none" });
      return;
    }
    let active = true;
    desktopClient
      .statFile(path)
      .then(info => active && setFile({ kind: isSupportedAudio(info.extension) ? "ready" : "unsupported", info }))
      .catch(() => active && setFile({ kind: "unreadable" }));
    return () => {
      active = false;
    };
  }, [path]);

  const detectedTitle = detected?.title ?? "";
  const detectedArtist = detected?.artist ?? "";
  useEffect(() => {
    void setFieldValue("title", detectedTitle);
    void setFieldValue("artist", detectedArtist);
  }, [detectedTitle, detectedArtist, setFieldValue]);

  const rows: FormRow[] = [{ type: "FolderField", tag: "path", label: t("audioFile"), required: true, placeholder: t("selectAudioFile"), readOnly: true },
    { tag: "title", label: t("title"), disabled: file.kind !== "ready" },
    { tag: "artist", label: t("artist"), disabled: file.kind !== "ready" }
  ];

  const handleClose = () => {
    formik.setStatus(undefined);
    onClose();
  };


  return (
    <Modal open={open} title={t("addSong")} closeLabel={t("closeDialog")} onClose={handleClose}>
      <form className="modalStack" noValidate onSubmit={formik.handleSubmit}>
        <div className="modalHero">
          <Music2 aria-hidden size={34} />
          <div>
            <strong>{t("addSong")}</strong>
            <span>{t("audioFileFormats")}</span>
          </div>
        </div>
        <RenderFormikFields formik={formik} items={rows} pickFolder={() => desktopClient.pickAudioFile()} />
        {(file.kind === "ready" || file.kind === "unsupported") && (
          <dl className="importInfo">
            <div>{t("importFileName", { value: file.info.name })}</div>
            <div>{t("importFormat", { value: file.info.extension.toUpperCase() })}</div>
            <div>{t("importSize", { value: formatBytes(file.info.sizeBytes) })}</div>
            
          </dl>
        )}
        {file.kind === "unsupported" && (
          <Alert intent="error">{t("errorUnsupportedMedia")}</Alert>
        )}
        {file.kind === "unreadable" && (
          <Alert intent="error">{t("errorInvalidMedia")}</Alert>
        )}
        <FormStatus status={formik.status} />
        <div className="modalActions">
          <Button type="button" variant="outlined" tone="neutral" disabled={formik.isSubmitting} onClick={handleClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={formik.isSubmitting || file.kind !== "ready"}>
            {t("addSong")}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
