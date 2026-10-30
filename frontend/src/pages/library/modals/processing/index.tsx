import { useQueryClient } from "@tanstack/react-query";
import { desktopClient } from "../../../../services/desktopClient";
import { refreshSongs } from "../../../../api/api-service";
import { useGuardedAction } from "../../songs/useGuardedAction";
import { pythonClient as catalog } from "../../../../services/pythonClient";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Dialog, IconButton, NeonWaves, SplitButton, Typography, tr, useLocale } from "@neo-ui-kit/react";
import type { ProcessingJobDto, SongDto } from "../../../../contracts/models";
import { ru } from "../../../../i18n/messages.ru";
import { formatBytes } from "../../../../shared/utils/format";
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
  onPlay,
  playbackDisabled,
}: Props) => {
  useLocale();
  const client = useQueryClient();
  const guarded = useGuardedAction();
  const onCancel = (jobId: string) => guarded(async () => {
    await catalog.cancelProcessing(jobId);
    await refreshSongs(client);
  });
  const onOpenFolder = (song: SongDto) => void desktopClient.revealProject(song.id, song.activeRevision);
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
    ? tr(ru.processingDiskUsage, {
        free: formatBytes(disk.free),
        used: formatBytes(disk.used),
      })
    : tr(ru.processingDiskUnavailable);

  const songOf = (job: ProcessingJobDto) =>
    songsById.get(job.songId);
  const details = (job: ProcessingJobDto) => {
    const song = songOf(job);
    setNotice({
      title: tr(ru.processingJobDetails),
      text: [
        processingTitle(job, song) ?? tr(ru.processingSongUnavailable),
        `${tr(ru.processingDetailsState)}: ${tr(ru[stateLabel[job.state]])}`,
        `${tr(ru.processingDetailsStage)}: ${job.stage}`,
        `${tr(ru.processingDetailsProgress)}: ${job.progress}%`,
        `${tr(ru.processingDetailsTime)}: ${processingDuration(job) ?? "0:00"}`,
        job.error?.message ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
      confirm: tr(ru.done),
    });
  };
  const stop = (job: ProcessingJobDto) =>
    setNotice({
      title: tr(ru.processingStopTitle),
      text: tr(ru.processingStopText),
      confirm: tr(ru.processingStop),
      cancel: tr(ru.cancel),
      onConfirm: () => void onCancel(job.id),
    });
  const remove = (job: ProcessingJobDto) =>
    setNotice({
      title: tr(ru.processingRemoveTitle),
      text: tr(ru.processingRemoveText),
      confirm: tr(ru.processingRemoveConfirm),
      cancel: tr(ru.cancel),
      onConfirm: () => queue.hide([job.id]),
    });
  const clear = (group: (typeof clearGroups)[keyof typeof clearGroups]) => {
    const selected = queue.visible.filter(group.matches);
    setNotice({
      title: tr(ru[group.title]),
      text: tr(ru[group.text], { count: selected.length }),
      confirm: tr(ru.processingClear),
      cancel: tr(ru.cancel),
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
      title={tr(ru.processingQueue)}
      closeLabel={tr(ru.closeDialog)}
      cancelLabel={false}
      confirmLabel={false}
      description={tr(ru.processingSummary, {
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
              {tr(ru.processingLoadFailed)}
            </Typography>
          )}
          {!queue.failed && queue.ordered.length === 0 && (
            <Typography tone="muted">{tr(ru.processingEmpty)}</Typography>
          )}
          <ul className="processingList" ref={listRef} style={{ height: rows.getTotalSize() }} aria-label={tr(ru.processingQueue)}>
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
            label={tr(ru.processingDiskInfo)}
            onClick={() =>
              setNotice({
                title: tr(ru.processingDiskTitle),
                text: diskText,
                confirm: tr(ru.done),
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
            label={tr(ru.processingClear)}
            onClick={() =>
              queue.visible.length > 0 && clear(clearGroups.completed)
            }
            items={Object.entries(clearGroups).map(([id, group]) => ({
              id,
              label: tr(ru[group.label]),
              disabled: !queue.visible.some(group.matches),
              onSelect: () => clear(group),
            }))}
          >
            {tr(ru.processingClear)}
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
