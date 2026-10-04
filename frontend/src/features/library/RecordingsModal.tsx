import { useMemo, useState } from "react";
import { Dialog, Icon, Planet, SegmentedControl, Typography } from "@ad-voice/ui";
import type { RecordingDto, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { formatBytes } from "../../shared/utils/format";
import { RecordingCard } from "./RecordingCard";
import { defaultTakeName, numberTakes } from "./takeNames";
import "./recordings.css";

interface Props {
  song: SongDto | null;
  recordings: readonly RecordingDto[];
  onClose(): void;
  onAnalyze(recording: RecordingDto): void;
  onDelete(recording: RecordingDto): void;
  onRename(recording: RecordingDto, name: string): void;
}
type View = "list" | "grid";

/** "Performances" written by hand in the corner of the header. */
const PerformancesSignature = () => <svg className="recordingsSignature" viewBox="0 0 194 50" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 45C12 34 20 16 25 9C33 -2 48 6 37 16C30 22 17 27 11 25M15 36C26 28 31 21 24 18"/><path d="M30 32C36 29 39 23 35 25C28 28 26 39 35 33L43 26C46 21 43 25 41 31L48 26Q54 23 52 27"/><path d="M48 47C52 36 54 24 60 18C68 9 71 9 67 15C63 22 57 26 52 28M50 28L65 25"/><path d="M66 25C61 25 59 38 65 32C69 28 70 23 66 25M65 33L76 25Q80 20 76 28L82 24Q87 23 84 27"/><path d="M81 33L88 23Q92 19 88 27L96 22Q101 20 96 28L104 23Q112 17 107 27C104 34 112 28 116 24"/><path d="M120 23C119 17 110 28 114 31C118 32 124 20 123 22L120 29C120 33 127 26 130 24"/><path d="M128 30L134 21Q138 19 134 27L142 21Q148 16 144 25C139 35 150 25 155 22"/><path d="M160 18C159 14 150 22 151 27C152 31 161 22 165 20"/><path d="M163 23C170 20 174 12 168 16C160 21 159 30 169 24L179 17"/><path d="M184 13C172 15 186 24 177 28C171 31 178 24 189 17"/></g></svg>;

/** A song's takes: listen, rename, analyze, reveal or delete each, as a list or a grid. */
export const RecordingsModal = ({ song, recordings, onClose, onAnalyze, onDelete, onRename }: Props) => {
  const t = useText();
  const [view, setView] = useState<View>("list");
  const numbers = useMemo(() => numberTakes(recordings), [recordings]);
  const totalSize = useMemo(() => recordings.reduce((sum, recording) => sum + recording.sizeBytes, 0), [recordings]);
  if (!song) return null;
  const nameOf = (recording: RecordingDto) =>
    recording.displayName || defaultTakeName(numbers.get(recording.id) ?? 1, recording.createdAt);

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }} className="recordingsDialog" width="large" icon="music"
      title={<><Typography as="span" variant="eyebrow" tone="accent" className="recordingsEyebrow">{t("songPerformances")}</Typography>{song.title}</>}
      description={t("recordingsHint")} closeLabel={t("closeDialog")} cancelLabel={false} confirmLabel={false}
      art={<><Planet className="recordingsPlanet" /><PerformancesSignature /></>}>
      <div className="recordingsBody">
        {recordings.length > 0 ? (
          <ul className="recordingsList" data-view={view} aria-label={t("recordings")}>
            {recordings.map((recording, index) => (
              <RecordingCard key={recording.id} recording={recording} index={index} name={nameOf(recording)}
                onRename={value => onRename(recording, value)} onAnalyze={onAnalyze} onDelete={onDelete} />
            ))}
          </ul>
        ) : (
          <Typography tone="muted" className="recordingsEmpty">{t("noRecordings")}</Typography>
        )}
        <footer className="recordingsFooter">
          <SegmentedControl<View> size="sm" label={t("recordings")} value={view} onValueChange={setView} items={[
            { value: "list", label: t("recordingsListView"), icon: "list" },
            { value: "grid", label: t("recordingsGridView"), icon: "grid" },
          ]} />
          <Typography variant="caption" tone="muted">{t("recordingsCount", { count: recordings.length })}</Typography>
          <Typography variant="caption" className="recordingsSize">
            <Icon name="database" />{t("recordingsTotalSize", { size: formatBytes(totalSize) })}
          </Typography>
        </footer>
      </div>
    </Dialog>
  );
};
