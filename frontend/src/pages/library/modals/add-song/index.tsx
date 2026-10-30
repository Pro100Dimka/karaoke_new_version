import { desktopClient as files } from "../../../../services/desktopClient";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, FilePicker, MessageBar, ProgressBar, Stack, Typography, useForm, tr, useLocale } from "@neo-ui-kit/react";
import type {
  ImportMetadata,
  ImportOptions,
  ImportProgress,
} from "../../../../contracts/clients";
import type { MessageKey } from "../../../../i18n/messages";
import { ru } from "../../../../i18n/messages.ru";
import { errorMessageKey, toAppError } from "../../../../shared/errors";
import { formatBytes } from "../../../../shared/utils/format";
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
const fileErrors = {
  none: null,
  ready: null,
  unsupported: "errorUnsupportedMedia",
  unreadable: "errorInvalidMedia",
} as const satisfies Record<FileState["kind"], MessageKey | null>;

/** Picking an audio file and importing it; title and artist are detected, so nothing else is asked. */
export const AddSongModal = ({
  open,
  initialPath = "",
  onClose,
  onImport,
}: AddSongModalProps) => {
  useLocale();
  const [file, setFile] = useState<FileState>({ kind: "none" });
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const importController = useRef<AbortController | null>(null);
  const [failure, setFailure] = useState<string>();

  const form = useForm({
    initialValues: { path: initialPath },
    reinitialize: false,
    validate: () =>
      file.kind === "ready" ? {} : { path: tr(ru.chooseAudioFirst) },
    onSubmit: async (values, current) => {
      setFailure(undefined);
      const controller = new AbortController();
      importController.current = controller;
      setProgress({ jobId: "", stage: tr(ru.importing), progress: 0 });
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
          setFailure(tr(ru.importCancelled));
          return;
        }
        const key = errorMessageKey(toAppError(failure));
        setFailure(key ? tr(ru[key]) : tr(ru.importFailed));
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
    files
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
  }, [path, files]);

  const pickAudio = async () => {
    const picked = await files.pickAudioFile();
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
  const fileError = fileErrors[file.kind];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
      className="addSongDialog"
      icon="plus"
      title={tr(ru.addSong)}
      closeLabel={tr(ru.closeDialog)}
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
          label={tr(ru.addSong)}
          description={tr(ru.audioFileFormats)}
          value={info?.name}
          onPick={() => void pickAudio()}
        />
        {info && (
          <Typography variant="caption" tone="muted" className="importInfo">
            {tr(ru.importFormat, { value: info.extension.toUpperCase() })} ·{" "}
            {tr(ru.importSize, { value: formatBytes(info.sizeBytes) })}
          </Typography>
        )}
        {fileError && <MessageBar tone="error">{tr(ru[fileError])}</MessageBar>}
        {failure && <MessageBar tone="error">{failure}</MessageBar>}
        {progress && (
          <Stack gap={1}>
            <Typography variant="caption" tone="muted">
              {progress.stage} · {progress.progress}%
            </Typography>
            <ProgressBar label={tr(ru.importing)} value={progress.progress} />
          </Stack>
        )}
        <div className="addSongActions">
          <Button
            onClick={() => {
              if (form.submitting) importController.current?.abort();
              else handleClose();
            }}
          >
            {tr(ru[form.submitting ? "cancelImport" : "cancel"])}
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon="plus"
            disabled={form.submitting || file.kind !== "ready"}
          >
            {tr(ru.addSong)}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
