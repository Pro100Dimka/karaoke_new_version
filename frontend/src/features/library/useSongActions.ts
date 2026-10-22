import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { useLibraryCatalog } from "../../app/LibraryProvider";
import { useEditorRepository } from "../../app/EditorProvider";
import { useGuardedAction } from "./useGuardedAction";

interface SongOperations {
  processSong(song: SongDto, mode?: "lyrics"): Promise<void>;
  refresh(): Promise<void>;
  deleteSong(song: SongDto): Promise<void>;
}

/** Confirmed, notified song-level actions shared by the card menu and the Song Settings dialog. */
export const useSongActions = (
  { processSong, refresh, deleteSong }: SongOperations,
  onDeleted: () => void,
) => {
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const guarded = useGuardedAction();
  const catalog = useLibraryCatalog();
  const repository = useEditorRepository();

  const startProcessing = (song: SongDto, mode?: "lyrics") =>
    guarded(async () => {
      await processSong(song, mode);
      notify(t("processingStarted"), "info");
    });

  const resetAndReprocess = async (song: SongDto) => {
    const choice = await ask({
      title: t("resetLyricsTitle"),
      body: t("resetLyricsBody", { revision: song.activeRevision }),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "reset", label: t("resetLyricsAndReprocess"), appearance: "primary" },
      ],
    });
    if (choice !== "reset") return;
    await guarded(async () => {
      const revision = await repository.reset(song.id, song.activeRevision);
      await refresh();
      await processSong({ ...song, activeRevision: revision }, "lyrics");
      notify(t("processingStarted"), "info");
    });
  };

  const confirmDelete = async (song: SongDto) => {
    let count = 0;
    try {
      count = (await catalog.listRecordings(song.id)).length;
    } catch {
      // The count is informational; deletion is still confirmed explicitly.
    }
    const choice = await ask({
      title: t("deleteSongTitle", { value: song.title }),
      body: t("deleteSongBody", { count }),
      actions: [
        { id: "cancel", label: t("cancel") },
        { id: "delete", label: t("deleteSong"), appearance: "primary" },
      ],
    });
    if (choice !== "delete") return;
    await guarded(async () => {
      await deleteSong(song);
      onDeleted();
      notify(t("songDeleted"), "success");
    });
  };

  const showError = async (song: SongDto) => {
    let message = t("errorProjectInvalid");
    try {
      const failed = (await catalog.listJobs()).find(
        (job) => job.songId === song.id && job.error,
      );
      if (failed?.error)
        message = `${failed.error.code}: ${failed.error.message}`;
    } catch {
      // Fall back to the generic explanation.
    }
    await ask({
      title: `${song.artist} — ${song.title}`,
      body: message,
      actions: [{ id: "ok", label: t("close"), appearance: "primary" }],
    });
  };

  return { startProcessing, resetAndReprocess, confirmDelete, showError };
};
