import { CircleAlert, CircleDot, OctagonX, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { pythonClient } from "../../services/pythonClient";
import { Modal } from "../../shared/ui/Modal";
import { Button, Progress, Typography } from "../../theme/ui";

interface Props {
  open: boolean;
  songs: readonly SongDto[];
  focusSongId?: string;
  onClose(): void;
  onCancel(jobId: string): Promise<void>;
  onRetry(song: SongDto): Promise<void>;
}

const stateLabel = {
  queued: "jobQueued",
  processing: "jobProcessing",
  cancelling: "jobCancelling",
  completed: "jobCompleted",
  failed: "failed",
  cancelled: "jobCancelled",
  interrupted: "jobInterrupted"
} as const satisfies Record<ProcessingJobDto["state"], MessageKey>;

const cancellable = new Set<ProcessingJobDto["state"]>(["queued", "processing"]);
const retryable = new Set<ProcessingJobDto["state"]>(["failed", "interrupted", "cancelled"]);
const pollMilliseconds = 1000;

/** Shows the authoritative queue from the backend; closing it never stops the work. */
export const ProcessingModal = ({ open, songs, focusSongId, onClose, onCancel, onRetry }: Props) => {
  const t = useText();
  const [jobs, setJobs] = useState<readonly ProcessingJobDto[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () =>
      pythonClient
        .listJobs()
        .then(items => active && (setJobs(items), setFailed(false)))
        .catch(() => active && setFailed(true));
    void load();
    const timer = window.setInterval(() => void load(), pollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open]);

  const titleOf = (songId: string): string => {
    const song = songs.find(item => item.id === songId);
    return song ? `${song.artist} — ${song.title}` : songId;
  };
  const ordered = [...jobs].sort(
    (a, b) => Number(b.songId === focusSongId) - Number(a.songId === focusSongId)
  );

  return (
    <Modal open={open} title={t("processingQueue")} closeLabel={t("closeDialog")} onClose={onClose}>
      {failed && <p role="alert">{t("processingLoadFailed")}</p>}
      {!failed && ordered.length === 0 && <p className="muted">{t("processingEmpty")}</p>}
      <ul className="processingList">
        {ordered.map(job => {
          const song = songs.find(item => item.id === job.songId);
          return (
            <li key={job.id} className="processingRow">
              <div className="processingMeta">
                <Typography as="span" variant="body1">
                  <CircleDot aria-hidden size={14} /> {titleOf(job.songId)}
                </Typography>
                <Typography as="span" variant="caption" tone="muted">
                  {t(stateLabel[job.state])} · {job.stage} · {job.progress}%
                </Typography>
                {(job.state === "processing" || job.state === "queued" || job.state === "cancelling") && (
                  <Progress aria-label={t("processing")} value={job.progress} />
                )}
                {job.error && (
                  <Typography as="span" variant="caption" tone="danger" role="alert">
                    <CircleAlert aria-hidden size={14} /> {job.error.message}
                  </Typography>
                )}
              </div>
              <div className="modalActions">
                {cancellable.has(job.state) && (
                  <Button size="sm" variant="outlined" tone="neutral" startIcon={<OctagonX size={15} />} onClick={() => void onCancel(job.id)}>
                    {t("cancel")}
                  </Button>
                )}
                {retryable.has(job.state) && song && (
                  <Button size="sm" variant="outlined" tone="neutral" startIcon={<RotateCcw size={15} />} onClick={() => void onRetry(song)}>
                    {t("retry")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
};
