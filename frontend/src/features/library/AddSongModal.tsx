import { Music2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ImportMetadata, ImportOptions, ImportProgress } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { Alert } from "../../shared/ui/Alert";
import { FormStatus } from "../../shared/ui/FormStatus";
import { Modal } from "../../shared/ui/Modal";
import { Button, Progress, Typography, useGetForm } from "../../theme/ui";
import { formatBytes } from "../../shared/utils/format";
import { isSupportedAudio } from "./importModel";

interface AddSongModalProps {
  open: boolean;
  initialPath?: string;
  onClose(): void;
  onImport(path: string, metadata: ImportMetadata, options: ImportOptions): Promise<void>;
}

type FileState =
  | { kind: "none" }
  | { kind: "ready"; info: FileInfo }
  | { kind: "unsupported"; info: FileInfo }
  | { kind: "unreadable" };

export const AddSongModal = ({ open, initialPath = "", onClose, onImport }: AddSongModalProps) => {
  const t = useText();
  const [file, setFile] = useState<FileState>({ kind: "none" });
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const importController = useRef<AbortController | null>(null);

  const formik = useGetForm({
    initialValues: { path: initialPath },
    enableReinitialize: false,
    validate: () => (file.kind === "ready" ? {} : { path: t("chooseAudioFirst") }),
    onSubmit: async (values, helpers) => {
      helpers.setStatus(undefined);
      const controller = new AbortController();
      importController.current = controller;
      setProgress({ jobId: "", stage: t("importing"), progress: 0 });
      try {
        await onImport(values.path, {}, { signal: controller.signal, onProgress: setProgress });
        helpers.resetForm({ values: { path: "" } });
        setProgress(null);
        onClose();
      } catch (failure) {
        setProgress(null);
        if (failure instanceof DOMException && failure.name === "AbortError") {
          helpers.setStatus(t("importCancelled"));
          return;
        }
        const key = errorMessageKey(toAppError(failure));
        helpers.setStatus(key ? t(key) : t("importFailed"));
      } finally {
        importController.current = null;
      }
    }
  });
  const { path } = formik.values;
  const { resetForm, setFieldValue } = formik;
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

  const pickAudio = async () => {
    const picked = await desktopClient.pickAudioFile();
    if (picked) await setFieldValue("path", picked);
  };

  const handleClose = () => {
    formik.setStatus(undefined);
    importController.current?.abort();
    setProgress(null);
    onClose();
  };


  return (
    <Modal open={open} title={t("addSong")} closeLabel={t("closeDialog")} onClose={handleClose}>
      <form className="modalStack" noValidate onSubmit={formik.handleSubmit}>
        <button type="button" className="audioFilePicker" onClick={() => void pickAudio()}>
          <Music2 aria-hidden size={34} />
          <div>
            <strong>{t("addSong")}</strong>
            <span>{file.kind === "ready" || file.kind === "unsupported" ? file.info.name : t("audioFileFormats")}</span>
          </div>
        </button>
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
        {progress && (
          <div className="importProgress">
            <Typography as="span" variant="caption" tone="muted">
              {progress.stage} · {progress.progress}%
            </Typography>
            <Progress aria-label={t("importing")} value={progress.progress} />
          </div>
        )}
        <div className="modalActions">
          <Button type="button" variant="outlined" tone="neutral" onClick={() => {
            if (formik.isSubmitting) importController.current?.abort();
            else handleClose();
          }}>
            {t(formik.isSubmitting ? "cancelImport" : "cancel")}
          </Button>
          <Button type="submit" disabled={formik.isSubmitting || file.kind !== "ready"}>
            {t("addSong")}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
