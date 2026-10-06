import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  FilePicker,
  MessageBar,
  ProgressBar,
  Stack,
  Typography,
  useForm,
} from "@ad-voice/ui";
import type {
  ImportMetadata,
  ImportOptions,
  ImportProgress,
} from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { formatBytes } from "../../shared/utils/format";
import { isSupportedAudio } from "./importModel";

interface AddSongModalProps {
  open: boolean;
  initialPath?: string;
  onClose(): void;
  onImport(
    path: string,
    metadata: ImportMetadata,
    options: ImportOptions,
  ): Promise<void>;
}

type FileState =
  | { kind: "none" }
  | { kind: "ready"; info: FileInfo }
  | { kind: "unsupported"; info: FileInfo }
  | { kind: "unreadable" };

/** Picking an audio file and importing it; title and artist are detected, so nothing else is asked. */
export const AddSongModal = ({
  open,
  initialPath = "",
  onClose,
  onImport,
}: AddSongModalProps) => {
  const t = useText();
  const [file, setFile] = useState<FileState>({ kind: "none" });
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const importController = useRef<AbortController | null>(null);
  const [failure, setFailure] = useState<string>();

  const form = useForm({
    initialValues: { path: initialPath },
    reinitialize: false,
    validate: () =>
      file.kind === "ready" ? {} : { path: t("chooseAudioFirst") },
    onSubmit: async (values, current) => {
      setFailure(undefined);
      const controller = new AbortController();
      importController.current = controller;
      setProgress({ jobId: "", stage: t("importing"), progress: 0 });
      try {
        await onImport(
          values.path,
          {},
          { signal: controller.signal, onProgress: setProgress },
        );
        current.reset({ path: "" });
        setProgress(null);
        onClose();
      } catch (failure) {
        setProgress(null);
        if (failure instanceof DOMException && failure.name === "AbortError") {
          setFailure(t("importCancelled"));
          return;
        }
        const key = errorMessageKey(toAppError(failure));
        setFailure(key ? t(key) : t("importFailed"));
      } finally {
        importController.current = null;
      }
    },
  });
  const { path } = form.values;
  const { reset, setValue } = form;
  useEffect(() => {
    if (open) reset({ path: initialPath });
  }, [open, initialPath, reset]);

  useEffect(() => {
    if (!path) {
      setFile({ kind: "none" });
      return;
    }
    let active = true;
    desktopClient
      .statFile(path)
      .then(
        (info) =>
          active &&
          setFile({
            kind: isSupportedAudio(info.extension) ? "ready" : "unsupported",
            info,
          }),
      )
      .catch(() => active && setFile({ kind: "unreadable" }));
    return () => {
      active = false;
    };
  }, [path]);

  const pickAudio = async () => {
    const picked = await desktopClient.pickAudioFile();
    if (picked) setValue("path", picked);
  };
  const handleClose = () => {
    setFailure(undefined);
    importController.current?.abort();
    setProgress(null);
    onClose();
  };
  const info =
    file.kind === "ready" || file.kind === "unsupported" ? file.info : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
      className="addSongDialog"
      icon="plus"
      title={t("addSong")}
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      confirmLabel={false}
    >
      <form
        className="addSongForm"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.submit();
        }}
      >
        <FilePicker
          variant="zone"
          className="audioFilePicker"
          icon="music"
          label={t("addSong")}
          description={t("audioFileFormats")}
          value={info?.name}
          onPick={() => void pickAudio()}
        />
        {info && (
          <Typography variant="caption" tone="muted" className="importInfo">
            {t("importFormat", { value: info.extension.toUpperCase() })} ·{" "}
            {t("importSize", { value: formatBytes(info.sizeBytes) })}
          </Typography>
        )}
        {file.kind === "unsupported" && (
          <MessageBar tone="error">{t("errorUnsupportedMedia")}</MessageBar>
        )}
        {file.kind === "unreadable" && (
          <MessageBar tone="error">{t("errorInvalidMedia")}</MessageBar>
        )}
        {failure && <MessageBar tone="error">{failure}</MessageBar>}
        {progress && (
          <Stack gap={1}>
            <Typography variant="caption" tone="muted">
              {progress.stage} · {progress.progress}%
            </Typography>
            <ProgressBar label={t("importing")} value={progress.progress} />
          </Stack>
        )}
        <div className="addSongActions">
          <Button
            onClick={() => {
              if (form.submitting) importController.current?.abort();
              else handleClose();
            }}
          >
            {t(form.submitting ? "cancelImport" : "cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon="plus"
            disabled={form.submitting || file.kind !== "ready"}
          >
            {t("addSong")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
