import { Activity, AlertTriangle, Check, CircleDot, Clock3, Database, Folder, Info, MoreHorizontal, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useState, type CSSProperties, type UIEvent } from "react";
import type { ProcessingJobDto, SongDto } from "../../contracts/models";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { pythonClient } from "../../services/pythonClient";
import { Modal } from "../../theme/ui";
import { NeonFrame } from "../../shared/ui/NeonFrame";
import processingQueueBackgroundUrl from "./assets/processing-queue-background.svg";
import processingQueueHeaderUrl from "./assets/processing-queue-header.svg";
import "./reference-modals.css";

interface Props { open: boolean; songs: readonly SongDto[]; focusSongId?: string; onClose(): void; onCancel(jobId: string): Promise<void>; onRetry(song: SongDto): Promise<void>; onOpenFolder(song: SongDto): void; onPlay(song: SongDto): void; }
interface QueueDialog { title: string; text: string; confirm: string; cancel?: string; onConfirm?(): void; }
const stateLabel = { queued: "jobQueued", processing: "jobProcessing", cancelling: "jobCancelling", completed: "jobCompleted", failed: "failed", cancelled: "jobCancelled", interrupted: "jobInterrupted" } as const satisfies Record<ProcessingJobDto["state"], MessageKey>;
const pollMilliseconds = 1000;
const processingDuration = (job: ProcessingJobDto): string | undefined => {
  if (!job.startedAt || !job.finishedAt) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return undefined;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const QueueBackdrop = ({ song, index }: { song?: SongDto; index: number }) => (
  <div className="processingCover" style={song?.artworkUrl ? { backgroundImage: `url(${song.artworkUrl})` } : undefined}>
    {!song?.artworkUrl && <span style={{ "--cover-index": index } as CSSProperties} />}
  </div>
);

export const ProcessingModal = ({ open, songs, focusSongId, onClose, onCancel, onRetry, onOpenFolder, onPlay }: Props) => {
  const t = useText();
  const [jobs, setJobs] = useState<readonly ProcessingJobDto[]>([]);
  const [failed, setFailed] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [queueOrder, setQueueOrder] = useState<readonly string[]>([]);
  const [hiddenJobIds, setHiddenJobIds] = useState<ReadonlySet<string>>(new Set());
  const [menuJobId, setMenuJobId] = useState<string>();
  const [dialog, setDialog] = useState<QueueDialog>();
  const [motionPaused, setMotionPaused] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    let timer: number | undefined;
    const load = () => pythonClient.listJobs().then(items => {
      if (!active) return;
      setJobs(items);
      setQueueOrder(previous => {
        const queuedIds = items.filter(item => item.state === "queued").map(item => item.id);
        return [...previous.filter(id => queuedIds.includes(id)), ...queuedIds.filter(id => !previous.includes(id))];
      });
      setFailed(false);
    }).catch(() => active && setFailed(true)).finally(() => { if (active) timer = window.setTimeout(() => void load(), pollMilliseconds); });
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [open]);
  const visibleJobs = jobs.filter(job => !hiddenJobIds.has(job.id));
  const focusedJobs = [...visibleJobs].sort((a, b) => Number(b.songId === focusSongId) - Number(a.songId === focusSongId));
  const queuedJobs = focusedJobs.filter(job => job.state === "queued").sort((a, b) => queueOrder.indexOf(a.id) - queueOrder.indexOf(b.id));
  const ordered = focusedJobs.map(job => job.state === "queued" ? queuedJobs.shift()! : job);
  const count = (states: readonly ProcessingJobDto["state"][]) => visibleJobs.filter(job => states.includes(job.state)).length;
  const hideJobs = (ids: readonly string[]) => setHiddenJobIds(previous => new Set([...previous, ...ids]));
  const moveQueuedJob = (jobId: string, direction: -1 | 1) => setQueueOrder(previous => {
    const next = [...previous];
    const index = next.indexOf(jobId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= next.length) return previous;
    const current = next[index]!;
    next[index] = next[destination]!;
    next[destination] = current;
    return next;
  });
  const showDetails = (job: ProcessingJobDto, song?: SongDto) => setDialog({
    title: "Сведения о задаче",
    text: `${song ? `${song.artist} — ${song.title}` : job.songId}\n\nСостояние: ${t(stateLabel[job.state])}\nЭтап: ${job.stage}\nПрогресс: ${job.progress}%\nВремя: ${processingDuration(job) ?? "0:00"}${job.error?.message ? `\n\n${job.error.message}` : ""}`,
    confirm: "Готово",
  });
  const confirmCancel = (job: ProcessingJobDto) => setDialog({
    title: "Остановить обработку?",
    text: "Текущая обработка будет остановлена. Уже созданные файлы останутся на компьютере.",
    confirm: "Остановить",
    cancel: "Отмена",
    onConfirm: () => void onCancel(job.id),
  });
  return (
    <Modal isOpen={open} onClose={onClose} ariaLabel={t("processingQueue")} closeAriaLabel={t("closeDialog")} portal tilt={false} maxWidth="none" modalClassName="processingReferenceModal" closeClassName="libraryReferenceHiddenClose" neonFrame={<NeonFrame className="libraryReferenceShellFrame" variant="shell" order={0} />}>
      <div className={`processingQueueScene ${motionPaused ? "isMotionPaused" : ""}`}>
        <img className="processingQueueBackground" src={processingQueueBackgroundUrl} alt="" aria-hidden="true" />
        <header className="processingQueueHeader"><img className="processingQueueHeaderArt" src={processingQueueHeaderUrl} alt="" aria-hidden="true" /><h2>{t("processingQueue")}</h2><p>{visibleJobs.length} задач • {count(["completed"])} завершено • {count(["queued"])} в очереди • {count(["failed", "interrupted"])} с ошибкой</p><button type="button" className="libraryReferenceClose" onClick={onClose}><span>×</span>{t("close")}</button></header>
        <div className="processingQueueScroll" onScroll={(event: UIEvent<HTMLDivElement>) => { const node = event.currentTarget; setScrollProgress(node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight)); }}>
          {failed && <p className="processingReferenceMessage" role="alert">{t("processingLoadFailed")}</p>}
          {!failed && ordered.length === 0 && <p className="processingReferenceMessage">{t("processingEmpty")}</p>}
          <ul className="processingReferenceList">
            {ordered.map((job, index) => {
              const song = songs.find(item => item.id === job.songId);
              const duration = processingDuration(job) ?? "0:00";
              const active = job.state === "processing" || job.state === "cancelling";
              const done = job.state === "completed";
              const queued = job.state === "queued";
              const error = job.state === "failed" || job.state === "interrupted" || job.state === "cancelled";
              return <li key={job.id} className={`processingJobCard ${active ? "isProcessing" : ""} ${error ? "isError" : ""}`}>
                <NeonFrame order={index + 1} /><QueueBackdrop song={song} index={index} />
                <div className={`processingStateIcon ${done ? "isDone" : active ? "isActive" : queued ? "isQueued" : "isError"}`}>{done ? <Check /> : active ? <CircleDot /> : queued ? <Clock3 /> : <AlertTriangle />}</div>
                <div className="processingJobMain"><strong>{song ? `${song.artist} — ${song.title}` : job.songId}</strong><span>{t(stateLabel[job.state])} <i>•</i> {job.processingBackend ?? job.stage}</span><div className="processingProgressLine"><div className="processingTrack"><span style={{ width: `${job.progress}%` }} /></div><b>{job.progress}%</b><time>{duration}</time></div></div>
                <div className="processingJobTools">
                  {done && song && <><button type="button" aria-label={t("openFolder")} onClick={() => onOpenFolder(song)}><Folder /></button><button type="button" aria-label={t("play")} onClick={() => onPlay(song)}><Play /></button></>}
                  {active && <button type="button" className="danger" aria-label={t("cancel")} onClick={() => confirmCancel(job)}><Square /></button>}
                  {queued && <><button type="button" aria-label="Выше в очереди" disabled={queueOrder.indexOf(job.id) <= 0} onClick={() => moveQueuedJob(job.id, -1)}>↑</button><button type="button" aria-label="Ниже в очереди" disabled={queueOrder.indexOf(job.id) === queueOrder.length - 1} onClick={() => moveQueuedJob(job.id, 1)}>↓</button></>}
                  {error && song && <button type="button" aria-label={t("retry")} onClick={() => void onRetry(song)}><RotateCcw /></button>}
                  <button type="button" aria-label="Действия с задачей" aria-haspopup="menu" aria-expanded={menuJobId === job.id} onClick={() => setMenuJobId(current => current === job.id ? undefined : job.id)}><MoreHorizontal /></button>
                </div>
                {active && <div className="processingStages">{["Подготовка", "Анализ", "Модель", "Обработка", "Проверка", "Публикация"].map((label, stage) => <span key={label} className={stage < 3 ? "done" : stage === 3 ? "current" : ""}><i>{stage < 3 ? "✓" : ""}</i>{label}</span>)}</div>}
                {error && <div className="processingError"><AlertTriangle />{job.error?.message ?? t(stateLabel[job.state])}</div>}
                {job.processingBackend && <span className="processingHiddenMeta">{t("processingVia")}: {t(job.processingBackend === "Kaggle" ? "processingBackendKaggle" : "processingBackendLocal")}</span>}
                {processingDuration(job) && <span className="processingHiddenMeta">{t("processingDuration")}: {processingDuration(job)}</span>}
              </li>;
            })}
          </ul>
        </div>
        <div className="processingQueueScrollbar" aria-hidden="true"><span style={{ top: `${scrollProgress * 78}%` }} /></div>
        <footer className="processingQueueFooter"><button type="button" className="processingStorageInfo" aria-label="Информация о диске" onClick={() => setDialog({ title: "Место на диске", text: "42.7 GB / 232 GB — данные о свободном месте на диске.", confirm: "Готово" })}><Database /></button><span>Свободно на диске</span><div className="processingDisk"><i /></div><b>42.7 GB / 232 GB</b><button type="button" disabled={count(["completed"]) === 0} onClick={() => setDialog({ title: "Очистить завершённые задачи?", text: `Из списка будут убраны завершённые карточки (${count(["completed"])}). Записи и файлы не удаляются.`, confirm: "Очистить", cancel: "Отмена", onConfirm: () => hideJobs(visibleJobs.filter(job => job.state === "completed").map(job => job.id)) })}><Trash2 />Очистить завершённые</button></footer>
        {menuJobId && (() => {
          const job = visibleJobs.find(item => item.id === menuJobId);
          if (!job) return null;
          const song = songs.find(item => item.id === job.songId);
          const active = job.state === "processing" || job.state === "cancelling";
          const retryable = job.state === "failed" || job.state === "interrupted" || job.state === "cancelled";
          return <div className="processingQueueMenu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenuJobId(undefined); showDetails(job, song); }}><Info />Сведения о задаче</button>
            {retryable && song && <button type="button" role="menuitem" onClick={() => { setMenuJobId(undefined); void onRetry(song); }}><RotateCcw />Повторить</button>}
            {active && <button type="button" role="menuitem" onClick={() => { setMenuJobId(undefined); confirmCancel(job); }}><Square />Остановить</button>}
            <button type="button" role="menuitem" onClick={() => { setMotionPaused(value => !value); setMenuJobId(undefined); }}><Activity />{motionPaused ? "Включить анимации" : "Приостановить анимации"}</button>
            <i />
            <button type="button" role="menuitem" className="danger" onClick={() => { setMenuJobId(undefined); setDialog({ title: "Убрать задачу из списка?", text: "Будет удалена только карточка из очереди. Файлы на компьютере останутся без изменений.", confirm: "Убрать", cancel: "Отмена", onConfirm: () => hideJobs([job.id]) }); }}><Trash2 />Убрать из списка</button>
          </div>;
        })()}
        {dialog && <div className="processingDialogBackdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(undefined); }}><section className="processingDialog" role="dialog" aria-modal="true" aria-labelledby="processing-dialog-title"><h2 id="processing-dialog-title">{dialog.title}</h2><p>{dialog.text}</p><div>{dialog.cancel && <button type="button" onClick={() => setDialog(undefined)}>{dialog.cancel}</button>}<button type="button" className="primary" onClick={() => { const action = dialog.onConfirm; setDialog(undefined); action?.(); }}>{dialog.confirm}</button></div></section></div>}
      </div>
    </Modal>
  );
};
