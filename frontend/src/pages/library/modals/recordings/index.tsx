import { ru } from "../../../../i18n/messages.ru";
import { useMemo, useState } from "react";
import { Dialog, Icon, Planet, SegmentedControl, Typography, tr, useLocale } from "@neo-ui-kit/react";
import type { RecordingDto, SongDto } from "../../../../contracts/models";
import type { RecordingAnalysisProgress } from "../../../../contracts/clients";
import type { MessageKey } from "../../../../i18n/messages";
import { formatBytes } from "../../../../shared/utils/format";
import { RecordingCard } from "./RecordingCard";
import { defaultTakeName, numberTakes } from "./takeNames";
import "./recordings.css";

interface Props {
  song: SongDto | null;
  recordings: readonly RecordingDto[];
  onClose(): void;
  onAnalyze(recording: RecordingDto, recalculate?: boolean): void;
  progress?: Readonly<Record<string, RecordingAnalysisProgress>>;
  failures?: Readonly<Record<string, MessageKey>>;
  onCancelAnalysis?(jobId: string): void;
  onDelete(recording: RecordingDto): void;
  onRename(recording: RecordingDto, name: string): void;
}
type View = "list" | "grid";

/** "Performances" written by hand in the corner of the header. */
const PerformancesSignature = () => (
  <svg className="recordingsSignature" viewBox="0 0 194 50" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 45C12 34 20 16 25 9C33 -2 48 6 37 16C30 22 17 27 11 25M15 36C26 28 31 21 24 18" />
      <path d="M30 32C36 29 39 23 35 25C28 28 26 39 35 33L43 26C46 21 43 25 41 31L48 26Q54 23 52 27" />
      <path d="M48 47C52 36 54 24 60 18C68 9 71 9 67 15C63 22 57 26 52 28M50 28L65 25" />
      <path d="M66 25C61 25 59 38 65 32C69 28 70 23 66 25M65 33L76 25Q80 20 76 28L82 24Q87 23 84 27" />
      <path d="M81 33L88 23Q92 19 88 27L96 22Q101 20 96 28L104 23Q112 17 107 27C104 34 112 28 116 24" />
      <path d="M120 23C119 17 110 28 114 31C118 32 124 20 123 22L120 29C120 33 127 26 130 24" />
      <path d="M128 30L134 21Q138 19 134 27L142 21Q148 16 144 25C139 35 150 25 155 22" />
      <path d="M160 18C159 14 150 22 151 27C152 31 161 22 165 20" />
      <path d="M163 23C170 20 174 12 168 16C160 21 159 30 169 24L179 17" />
      <path d="M184 13C172 15 186 24 177 28C171 31 178 24 189 17" />
    </g>
  </svg>
);

/** A song's takes: listen, rename, analyze, reveal or delete each, as a list or a grid. */
export const RecordingsModal = ({
  song,
  recordings,
  onClose,
  onAnalyze,
  onDelete,
  onRename,
  progress,
  failures,
  onCancelAnalysis,
}: Props) => {
  useLocale();
  const [view, setView] = useState<View>("list");
  const numbers = useMemo(() => numberTakes(recordings), [recordings]);
  const versions = useMemo(() => {
    const grouped = new Map<string, RecordingDto[]>();
    for (const recording of recordings) {
      if (!recording.sourceRecordingId) continue;
      const items = grouped.get(recording.sourceRecordingId);
      if (items) items.push(recording);
      else grouped.set(recording.sourceRecordingId, [recording]);
    }
    return grouped;
  }, [recordings]);
  const performances = useMemo(() => {
    const ids = new Set(recordings.map((recording) => recording.id));
    return recordings.filter((recording) => !recording.sourceRecordingId || !ids.has(recording.sourceRecordingId));
  }, [recordings]);
  const totalSize = recordings.reduce(
    (sum, recording) => sum + recording.sizeBytes,
    0,
  );
  if (!song) return null;
  const nameOf = (recording: RecordingDto) =>
    recording.displayName ||
    (recording.sourceRecordingId ? tr(ru.studioMasterTitle) :
      defaultTakeName( numbers.get(recording.id) ?? 1, recording.createdAt));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="recordingsDialog"
      width="large"
      icon="music"
      title={
        <>
          <Typography
            as="span"
            variant="eyebrow"
            tone="accent"
            className="recordingsEyebrow"
          >
            {tr(ru.songPerformances)}
          </Typography>
          {song.title}
        </>
      }
      description={tr(ru.recordingsHint)}
      closeLabel={tr(ru.closeDialog)}
      cancelLabel={false}
      confirmLabel={false}
      art={
        <>
          <Planet className="recordingsPlanet" />
          <PerformancesSignature />
        </>
      }
    >
      <div className="recordingsBody">
        {recordings.length > 0 ? (
          <ul
            className="recordingsList"
            data-view={view}
            aria-label={tr(ru.recordings)}
          >
            {performances.map((recording, index) => (
              <RecordingCard
                key={recording.id}
                recording={recording}
                versions={versions.get(recording.id)}
                index={index}
                name={nameOf(recording)}
                onRename={(value) => onRename(recording, value)}
                onAnalyze={onAnalyze}
                progress={progress}
                failures={failures}
                onCancelAnalysis={onCancelAnalysis}
                onDelete={onDelete}
              />
            ))}
          </ul>
        ) : (
          <Typography tone="muted" className="recordingsEmpty">
            {tr(ru.noRecordings)}
          </Typography>
        )}
        <footer className="recordingsFooter">
          <SegmentedControl<View>
            size="sm"
            label={tr(ru.recordings)}
            value={view}
            onValueChange={setView}
            items={[
              { value: "list", label: tr(ru.recordingsListView), icon: "list" },
              { value: "grid", label: tr(ru.recordingsGridView), icon: "grid" },
            ]}
          />
          <Typography variant="caption" tone="muted">
            {tr(ru.recordingsCount, { count: performances.length })}
          </Typography>
          <Typography variant="caption" className="recordingsSize">
            <Icon name="database" />
            {tr(ru.recordingsTotalSize, { size: formatBytes(totalSize) })}
          </Typography>
        </footer>
      </div>
    </Dialog>
  );
};
