import { useState } from "react";
import { Card, IconButton, TextField, Typography } from "@ad-voice/ui";
import type { RecordingDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import performanceArtUrl from "./assets/performance-art.svg";
import { RecordingPlayer } from "./RecordingPlayer";
import { recordingStatusLabels } from "./songMetadataPresentation";

/** The take's name, renamed in place: Enter or the check saves, Escape keeps the old one. */
const TakeName = ({
  name,
  onRename,
}: {
  name: string;
  onRename(name: string): void;
}) => {
  const t = useText();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null)
    return (
      <div className="recordingName">
        <Typography as="strong" variant="title" truncate>
          {name}
        </Typography>
        <IconButton
          size="xs"
          variant="ghost"
          icon="pencil"
          label={t("renameTake")}
          onClick={() => setDraft(name)}
        />
      </div>
    );
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onRename(draft);
        setDraft(null);
      }}
    >
      <TextField
        size="sm"
        aria-label={t("renameTake")}
        autoFocus
        value={draft}
        onValueChange={setDraft}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(null);
        }}
        endAdornment={
          <IconButton
            type="submit"
            size="xs"
            variant="ghost"
            icon="check"
            label={t("save")}
          />
        }
      />
    </form>
  );
};

/** One take: its picture, name, file and analysis state, player and actions. */
export const RecordingCard = ({
  recording,
  name,
  index,
  onRename,
  onAnalyze,
  onDelete,
}: {
  recording: RecordingDto;
  name: string;
  index: number;
  onRename(name: string): void;
  onAnalyze(recording: RecordingDto): void;
  onDelete(recording: RecordingDto): void;
}) => {
  const t = useText();
  const statuses = recordingStatusLabels(
    recording.fileStatus ?? "Ready",
    recording.analysisStatus ?? "NotAnalyzed",
  );

  return (
    <li>
      <Card border padding="sm" className="recordingCard">
        <svg className="recordingArt" viewBox="0 0 240 204" aria-hidden="true">
          <use href={`${performanceArtUrl}#pf-art-${(index % 6) + 1}`} />
        </svg>
        <div className="recordingMain">
          <TakeName name={name} onRename={onRename} />
          <Typography variant="caption" tone="muted">
            {statuses.map((key) => t(key)).join("  •  ")}
          </Typography>
          <RecordingPlayer recording={recording} />
        </div>
        <div className="recordingActions">
          <IconButton
            icon="levels"
            label={t("recordingAnalyze")}
            onClick={() => onAnalyze(recording)}
          />
          <IconButton
            icon="folder"
            label={t("openFolder")}
            onClick={() =>
              void desktopClient.revealInExplorer(recording.filePath)
            }
          />
          <IconButton
            icon="trash"
            variant="danger"
            label={t("recordingDelete")}
            onClick={() => onDelete(recording)}
          />
        </div>
      </Card>
    </li>
  );
};
