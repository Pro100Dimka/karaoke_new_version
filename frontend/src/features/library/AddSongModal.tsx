import { Music2 } from "lucide-react";
import { useEffect, useState } from "react";
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
  onImport(path: string): Promise<void>;
}

type FileState =
  | { kind: "none" }
  | { kind: "ready"; info: FileInfo }
  | { kind: "unsupported"; info: FileInfo }
  | { kind: "unreadable" };

export const AddSongModal = ({ open, initialPath = "", onClose, onImport }: AddSongModalProps) => {
  const t = useText();
  const [file, setFile] = useState<FileState>({ kind: "none" });

  const formik = useGetForm({
    initialValues: { path: initialPath },
    enableReinitialize: false,
    validate: () => (file.kind === "ready" ? {} : { path: t("chooseAudioFirst") }),
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      try {
        await onImport(values.path);
        helpers.resetForm({ values: { path: "" } });
        onClose();
      } catch (failure) {
        const key = errorMessageKey(toAppError(failure));
        helpers.setStatus(key ? t(key) : t("importFailed"));
      }
    }
  });
  const { path } = formik.values;
  const { resetForm } = formik;

  useEffect(() => {
    if (open) resetForm({ values: { path: initialPath } });
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

  const rows: FormRow[] = [{ type: "FolderField", tag: "path", label: t("audioFile"), required: true, placeholder: t("selectAudioFile"), readOnly: true }];

  const handleClose = () => {
    formik.setStatus(undefined);
    onClose();
  };

  const guess = file.kind === "ready" ? guessMetadata(file.info.name) : null;

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
            {guess && (
              <div>{t("importDetected", { value: [guess.artist, guess.title].filter(Boolean).join(" — ") })}</div>
            )}
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
