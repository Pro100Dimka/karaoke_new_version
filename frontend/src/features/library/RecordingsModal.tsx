import { BarChart3, Check, FolderOpen, Music2, Pencil, Trash2, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { RecordingDto, SongDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { Modal } from "../../shared/ui/Modal";
import { formatTime } from "../../shared/utils/format";
import { Card, IconButton, RenderFormikFields, Typography, useGetForm } from "../../theme/ui";
import { defaultTakeName, loadTakeNames, numberTakes, saveTakeName } from "./takeNames";

interface Props {
  song: SongDto | null;
  recordings: readonly RecordingDto[];
  onClose(): void;
  onPlay(recording: RecordingDto): void;
  onAnalyze(recording: RecordingDto): void;
  onDelete(recording: RecordingDto): void;
}

interface RecordingAction {
  id: "play" | "analyze" | "folder" | "delete";
  label: MessageKey;
  icon: LucideIcon;
  destructive: boolean;
  run(): void;
}

const RecordingItem = ({
  recording,
  name,
  onRename,
  onPlay,
  onAnalyze,
  onDelete
}: {
  recording: RecordingDto;
  name: string;
  onRename(name: string): void;
  onPlay(recording: RecordingDto): void;
  onAnalyze(recording: RecordingDto): void;
  onDelete(recording: RecordingDto): void;
}) => {
  const t = useText();
  const [editing, setEditing] = useState(false);
  const formik = useGetForm({
    initialValues: { name },
    enableReinitialize: false,
    onSubmit: values => {
      onRename(values.name);
      setEditing(false);
    }
  });
  const actions = [
    { id: "play", label: "playRecording", icon: Music2, destructive: false, run: () => onPlay(recording) },
    { id: "analyze", label: "recordingAnalyze", icon: BarChart3, destructive: false, run: () => onAnalyze(recording) },
    { id: "folder", label: "openFolder", icon: FolderOpen, destructive: false, run: () => void desktopClient.revealInExplorer(recording.filePath) },
    { id: "delete", label: "recordingDelete", icon: Trash2, destructive: true, run: () => onDelete(recording) }
  ] satisfies readonly RecordingAction[];

  return (
    <li>
      <Card className="recordingRow" tilt={false}>
        <div className="recordingMeta">
          {editing ? (
            <form noValidate onSubmit={formik.handleSubmit}>
              <RenderFormikFields
                formik={formik}
                items={[
                  {
                    tag: "name",
                    autoFocus: true,
                    "aria-label": t("renameTake"),
                    end: <IconButton type="submit" size="sm" variant="ghost" icon={Check} label={t("save")} />
                  }
                ]}
              />
            </form>
          ) : (
            <Typography as="span" variant="body1">{name}</Typography>
          )}
          <Typography as="span" variant="caption" tone="muted">{formatTime(recording.durationSeconds)}</Typography>
        </div>
        <div className="recordingActions">
          <IconButton
            variant="ghost"
            icon={Pencil}
            label={t("renameTake")}
            onClick={() => {
              formik.resetForm({ values: { name } });
              setEditing(true);
            }}
          />
          {actions.map(({ id, label, icon, destructive, run }) => (
            <IconButton key={id} variant="ghost" tone={destructive ? "danger" : "neutral"} icon={icon} label={t(label)} onClick={run} />
          ))}
        </div>
      </Card>
    </li>
  );
};

export const RecordingsModal = ({ song, recordings, onClose, onPlay, onAnalyze, onDelete }: Props) => {
  const t = useText();
  const [names, setNames] = useState(loadTakeNames);
  const numbers = useMemo(() => numberTakes(recordings), [recordings]);
  if (!song) return null;

  const nameOf = (recording: RecordingDto): string => names[recording.id] ?? defaultTakeName(numbers.get(recording.id) ?? 1, recording.createdAt);

  return (
    <Modal open title={`${t("recordings")} · ${song.title}`} closeLabel={t("closeDialog")} onClose={onClose}>
      {recordings.length > 0 ? (
        <ul className="recordingList">
          {recordings.map(recording => (
            <RecordingItem
              key={recording.id}
              recording={recording}
              name={nameOf(recording)}
              onRename={value => {
                saveTakeName(recording.id, value);
                setNames(loadTakeNames());
              }}
              onPlay={onPlay}
              onAnalyze={onAnalyze}
              onDelete={onDelete}
            />
          ))}
        </ul>
      ) : (
        <Typography variant="body1">{t("noRecordings")}</Typography>
      )}
    </Modal>
  );
};
