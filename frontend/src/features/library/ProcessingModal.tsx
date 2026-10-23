import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  NeonWaves,
  ProgressBar,
  Typography,
} from "@neo-ui-kit/react";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { useLibraryCatalog } from "../../app/LibraryProvider";
import { formatBytes } from "../../shared/utils/format";
import { ProcessingJobCard } from "./ProcessingJobCard";
import { processingDuration, stateLabel } from "./processingModel";
import { useProcessingQueue } from "./useProcessingQueue";
import "./processing.css";

interface Props {
  open: boolean;
  songs: readonly SongDto[];
  focusSongId?: string;
  onClose(): void;
  onCancel(jobId: string): Promise<void>;
  onRetry(song: SongDto, mode?: "lyrics"): Promise<void>;
  onResetLyrics?(song: SongDto): Promise<void>;
  onOpenFolder(song: SongDto): void;
  onPlay(song: SongDto): void;
}
/** A question or a note over the queue: confirmed actions run only after "OK". */
interface Notice {
  title: string;
  text: string;
  confirm: string;
  cancel?: string;
  onConfirm?(): void;
}
type Disk = { free: number; total: number } | null;
const clearGroups = {
  completed: {
    label: "processingClearCompleted", title: "processingClearCompletedTitle", text: "processingClearCompletedText",
    matches: (job: ProcessingJobDto) => job.state === "completed",
  },
  failed: {
    label: "processingClearFailed", title: "processingClearFailedTitle", text: "processingClearFailedText",
    matches: (job: ProcessingJobDto) => job.state === "failed" || job.state === "interrupted",
  },
  all: {
    label: "processingClearAll", title: "processingClearAllTitle", text: "processingClearAllText",
    matches: () => true,
  },
} as const;

/** Real free space of the data disk, read once when the queue opens. */
const useDisk = (open: boolean): Disk => {
  const catalog = useLibraryCatalog();
  const [disk, setDisk] = useState<Disk>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void catalog
      .diagnostics()
      .then(({ storage }) => {
        const used =
          storage.songs +
          storage.models +
          storage.cache +
          storage.recordings +
          storage.temp;
        if (active) setDisk({ free: storage.free, total: storage.free + used });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open, catalog]);
  return disk;
};

/** Every song being processed, waiting or done: progress, order of the queue, and what can be done with each job. */
export const ProcessingModal = ({
  open,
  songs,
  focusSongId,
  onClose,
  onCancel,
  onRetry,
  onResetLyrics,
  onOpenFolder,
  onPlay,
}: Props) => {
  const t = useText();
  const queue = useProcessingQueue(open, focusSongId);
  const disk = useDisk(open);
  const [notice, setNotice] = useState<Notice>();
  const [motionPaused, setMotionPaused] = useState(false);
  const clearAnchor = useRef<HTMLButtonElement>(null);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const diskText = disk
    ? t("processingDiskUsage", {
        free: formatBytes(disk.free),
        total: formatBytes(disk.total),
      })
    : t("processingDiskUnavailable");

  const songOf = (job: ProcessingJobDto) =>
    songs.find((item) => item.id === job.songId);
  const details = (job: ProcessingJobDto) => {
    const song = songOf(job);
    setNotice({
      title: t("processingJobDetails"),
      text: [
        song ? `${song.artist} — ${song.title}` : job.songId,
        `${t("processingDetailsState")}: ${t(stateLabel[job.state])}`,
        `${t("processingDetailsStage")}: ${job.stage}`,
        `${t("processingDetailsProgress")}: ${job.progress}%`,
        `${t("processingDetailsTime")}: ${processingDuration(job) ?? "0:00"}`,
        job.error?.message ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
      confirm: t("done"),
    });
  };
  const stop = (job: ProcessingJobDto) =>
    setNotice({
      title: t("processingStopTitle"),
      text: t("processingStopText"),
      confirm: t("processingStop"),
      cancel: t("cancel"),
      onConfirm: () => void onCancel(job.id),
    });
  const remove = (job: ProcessingJobDto) =>
    setNotice({
      title: t("processingRemoveTitle"),
      text: t("processingRemoveText"),
      confirm: t("processingRemoveConfirm"),
      cancel: t("cancel"),
      onConfirm: () => queue.hide([job.id]),
    });
  const clear = (group: (typeof clearGroups)[keyof typeof clearGroups]) => {
    const selected = queue.visible.filter(group.matches);
    setNotice({
      title: t(group.title),
      text: t(group.text, { count: selected.length }),
      confirm: t("processingClear"),
      cancel: t("cancel"),
      onConfirm: () => queue.hide(selected.map((job) => job.id)),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      className="processingDialog"
      width="large"
      icon="processing"
      title={t("processingQueue")}
      closeLabel={t("closeDialog")}
      cancelLabel={false}
      confirmLabel={false}
      description={t("processingSummary", {
        total: queue.visible.length,
        active: queue.count(["processing", "cancelling"]),
        queued: queue.count(["queued"]),
      })}
      art={<NeonWaves className="processingWaves" strands={26} />}
    >
      <div
        className="processingBody"
        data-ad-motion={motionPaused ? "off" : undefined}
      >
        <div className="processingScroll">
          {queue.failed && (
            <Typography role="alert" tone="danger">
              {t("processingLoadFailed")}
            </Typography>
          )}
          {!queue.failed && queue.ordered.length === 0 && (
            <Typography tone="muted">{t("processingEmpty")}</Typography>
          )}
          <ul className="processingList" aria-label={t("processingQueue")}>
            {queue.ordered.map((job, index) => (
              <ProcessingJobCard
                key={job.id}
                job={job}
                song={songOf(job)}
                index={index}
                actions={{
                  canMove: (direction) => queue.canMove(job.id, direction),
                  onMove: (direction) => queue.move(job.id, direction),
                  onOpenFolder,
                  onPlay,
                  onRetry: (song) => void onRetry(song,
                    job.timingOperation === "lyrics" ? "lyrics" : undefined),
                  onResetLyrics,
                  onStop: () => stop(job),
                  onDetails: () => details(job),
                  onRemove: () => remove(job),
                  motionPaused,
                  onToggleMotion: () => setMotionPaused((value) => !value),
                }}
              />
            ))}
          </ul>
        </div>
        <footer className="processingFooter">
          <IconButton
            variant="ghost"
            icon="database"
            label={t("processingDiskInfo")}
            onClick={() =>
              setNotice({
                title: t("processingDiskTitle"),
                text: diskText,
                confirm: t("done"),
              })
            }
          />
          <div className="processingDisk">
            <Typography variant="caption" tone="muted">
              {t("processingDiskFree")}: {diskText}
            </Typography>
            {disk && (
              <ProgressBar
                label={t("processingDiskFree")}
                value={disk.total - disk.free}
                max={Math.max(1, disk.total)}
              />
            )}
          </div>
          <Button
            ref={clearAnchor}
            size="sm"
            icon="trash"
            aria-haspopup="menu"
            aria-expanded={clearMenuOpen}
            disabled={queue.visible.length === 0}
            onClick={() => setClearMenuOpen((value) => !value)}
          >
            {t("processingClear")}
          </Button>
          <Menu
            open={clearMenuOpen}
            onOpenChange={setClearMenuOpen}
            anchorRef={clearAnchor}
            align="end"
            items={Object.entries(clearGroups).map(([id, group]) => ({
              id, label: t(group.label), disabled: !queue.visible.some(group.matches),
              onSelect: () => clear(group),
            }))}
          />
        </footer>
      </div>
      <Dialog
        open={Boolean(notice)}
        onOpenChange={(next) => {
          if (!next) setNotice(undefined);
        }}
        className="processingNotice"
        title={notice?.title}
        description={notice?.text}
        confirmLabel={notice?.confirm}
        cancelLabel={notice?.cancel ?? false}
        onConfirm={() => notice?.onConfirm?.()}
      />
    </Dialog>
  );
};
