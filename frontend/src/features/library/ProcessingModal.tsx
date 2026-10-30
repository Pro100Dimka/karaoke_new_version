import { pythonClient as catalog } from "../../services/pythonClient";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Dialog,
  IconButton,
  NeonWaves,
  SplitButton,
  Typography,
} from "@neo-ui-kit/react";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { formatBytes } from "../../shared/utils/format";
import { ProcessingJobCard } from "./ProcessingJobCard";
import {
  processingDuration,
  processingTitle,
  stateLabel,
} from "./processingModel";
import { useProcessingQueue } from "./useProcessingQueue";
import "./processing.css";

interface Props {
  open: boolean;
  songs: readonly SongDto[];
  focusSongId?: string;
  onClose(): void;
  onCancel(jobId: string): Promise<void>;
  onOpenFolder(song: SongDto): void;
  onPlay(song: SongDto): void;
  playbackDisabled?: boolean;
}
/** A question or a note over the queue: confirmed actions run only after "OK". */
interface Notice {
  title: string;
  text: string;
  confirm: string;
  cancel?: string;
  onConfirm?(): void;
}
type Disk = { free: number; used: number } | null;
const clearGroups = {
  completed: {
    label: "processingClearCompleted",
    title: "processingClearCompletedTitle",
    text: "processingClearCompletedText",
    matches: (job: ProcessingJobDto) => job.state === "completed",
  },
  failed: {
    label: "processingClearFailed",
    title: "processingClearFailedTitle",
    text: "processingClearFailedText",
    matches: (job: ProcessingJobDto) =>
      job.state === "failed" || job.state === "interrupted",
  },
  all: {
    label: "processingClearAll",
    title: "processingClearAllTitle",
    text: "processingClearAllText",
    matches: () => true,
  },
} as const;

/** Real free space of the data disk, read once when the queue opens. */
const useDisk = (open: boolean): Disk => {
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
        if (active) setDisk({ free: storage.free, used });
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
  onOpenFolder,
  onPlay,
  playbackDisabled,
}: Props) => {
  const t = useText();
  const queue = useProcessingQueue(focusSongId);
  const disk = useDisk(open);
  const [notice, setNotice] = useState<Notice>();
  const [motionPaused, setMotionPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rows = useVirtualizer({
    count: queue.ordered.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => queue.ordered[index]?.id ?? index,
    estimateSize: () => 150,
    overscan: 2,
    enabled: open,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });
  const songsById = useMemo(() => new Map(songs.map((song) => [song.id, song])), [songs]);
  const diskText = disk
    ? t("processingDiskUsage", {
        free: formatBytes(disk.free),
        used: formatBytes(disk.used),
      })
    : t("processingDiskUnavailable");

  const songOf = (job: ProcessingJobDto) =>
    songsById.get(job.songId);
  const details = (job: ProcessingJobDto) => {
    const song = songOf(job);
    setNotice({
      title: t("processingJobDetails"),
      text: [
        processingTitle(job, song) ?? t("processingSongUnavailable"),
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
        <div className="processingScroll" ref={scrollRef}>
          {queue.failed && (
            <Typography role="alert" tone="danger">
              {t("processingLoadFailed")}
            </Typography>
          )}
          {!queue.failed && queue.ordered.length === 0 && (
            <Typography tone="muted">{t("processingEmpty")}</Typography>
          )}
          <ul className="processingList" ref={listRef} style={{ height: rows.getTotalSize() }} aria-label={t("processingQueue")}>
            {rows.getVirtualItems().map((row) => {
              const job = queue.ordered[row.index];
              if (!job) return null;
              return <li key={row.key} ref={rows.measureElement} data-index={row.index}
                aria-posinset={row.index + 1} aria-setsize={queue.ordered.length}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", paddingBottom: "var(--ad-space-3)",
                  transform: `translateY(${row.start - rows.options.scrollMargin}px)` }}>
              <ProcessingJobCard
                job={job}
                song={songOf(job)}
                index={row.index}
                actions={{
                  onOpenFolder,
                  onPlay,
                  playbackDisabled,
                  onStop: () => stop(job),
                  onDetails: () => details(job),
                  onRemove: () => remove(job),
                  motionPaused,
                  onToggleMotion: () => setMotionPaused((value) => !value),
                }}
              />
              </li>;
            })}
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
              {diskText}
            </Typography>
          </div>
          <SplitButton
            size="sm"
            icon="trash"
            aria-disabled={queue.visible.length === 0}
            label={t("processingClear")}
            onClick={() =>
              queue.visible.length > 0 && clear(clearGroups.completed)
            }
            items={Object.entries(clearGroups).map(([id, group]) => ({
              id,
              label: t(group.label),
              disabled: !queue.visible.some(group.matches),
              onSelect: () => clear(group),
            }))}
          >
            {t("processingClear")}
          </SplitButton>
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
