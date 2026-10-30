import { useRef, useState } from "react";
import { store } from "../../../providers/store";
import type { KaraokeTv } from "../../../features/karaoke/tv/karaokeTv";
import { roomSongPlayIntent } from "../../../features/room/roomSongIntent";
import { routes } from "../../../shared/routes";
import { markPlayed } from "./lastPlayed";
import type { useRoomLibrary } from "./useRoomLibrary";

export const curtainMilliseconds = 400;

import { tr, useLocale } from "@neo-ui-kit/react";
import { pythonClient as catalog } from "../../../services/pythonClient";
import { editorApi as repository } from "../../../pages/editor/editorApi";
import { ask } from "../../../providers/dialog";
import { useNotify } from "../../../providers/notifications";
import type { SongDto } from "../../../contracts/models";
import { ru } from "../../../i18n/messages.ru";
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
  playback?: {
    songs: readonly SongDto[];
    roomLibrary: ReturnType<typeof useRoomLibrary>;
    navigate(path: string): void;
    tv?: KaraokeTv | null;
  },
) => {
  const [launching, setLaunching] = useState(false);
  const processing = useRef(store.application.localProcessing);
  processing.current = store.application.localProcessing;
  const tv = playback?.tv;
  const notify = useNotify();
  useLocale();
  const guarded = useGuardedAction();

  const startProcessing = (song: SongDto) =>
    guarded(async () => {
      if (song.status !== "not-processed") return;
      await processSong(song);
      notify(tr(ru.processingStarted), "info");
    });

  const resetAndReprocess = async (song: SongDto) => {
    const choice = await ask({
      title: tr(ru.resetLyricsTitle),
      body: tr(ru.resetLyricsBody, { revision: song.activeRevision }),
      actions: [
        { id: "cancel", label: tr(ru.cancel) },
        {
          id: "reset",
          label: tr(ru.resetLyricsAndReprocess),
          appearance: "primary",
        },
      ],
    });
    if (choice !== "reset") return;
    await guarded(async () => {
      const revision = await repository.reset(song.id, song.activeRevision);
      await refresh();
      await processSong({ ...song, activeRevision: revision }, "lyrics");
      notify(tr(ru.processingStarted), "info");
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
      title: tr(ru.deleteSongTitle, { value: song.title }),
      body: tr(ru.deleteSongBody, { count }),
      actions: [
        { id: "cancel", label: tr(ru.cancel) },
        { id: "delete", label: tr(ru.deleteSong), appearance: "primary" },
      ],
    });
    if (choice !== "delete") return;
    await guarded(async () => {
      await deleteSong(song);
      onDeleted();
      notify(tr(ru.songDeleted), "success");
    });
  };

  const showError = async (song: SongDto) => {
    let message = tr(ru.errorProjectInvalid);
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
      actions: [{ id: "ok", label: tr(ru.close), appearance: "primary" }],
    });
  };

  // While someone sings on the TV a chosen song waits its turn there, or replaces the current one.
  const playOnTv = async (song: SongDto, rehearsal = false) => {
    if (!tv) return;
    const current = playback?.songs.find((item) => item.id === tv.songId);
    if (song.id === tv.songId) return;
    const choice = await ask({
      title: tr(ru.tvBusyTitle),
      body: tr(ru.tvBusyBody, {
        current: current?.title ?? "…",
        title: song.title,
      }),
      actions: [
        { id: "cancel", label: tr(ru.cancel) },
        { id: "next", label: tr(ru.tvQueueNext) },
        { id: "now", label: tr(ru.tvReplaceNow), appearance: "primary" },
      ],
    });
    if (processing.current || !["next", "now"].includes(choice ?? "")) return;
    markPlayed(song.id);
    tv.play(
      { id: song.id, title: song.title, artist: song.artist, rehearsal },
      choice === "next" ? "next" : "now",
    );
    if (choice === "next")
      notify(tr(ru.tvQueued, { title: song.title }), "success");
  };

  const playSong = (song: SongDto, rehearsal = false) => {
    if (processing.current) return;
    if (tv?.active) {
      void playOnTv(song, rehearsal);
      return;
    }
    if (!playback) return;
    const { roomLibrary, navigate } = playback;
    const intent = roomSongPlayIntent(roomLibrary.room);
    if (intent === "select-room") {
      void roomLibrary.selectSong(song);
      return;
    }
    if (intent === "wait-for-host") {
      notify(tr(ru.errorRoomPermission), "warning");
      return;
    }
    markPlayed(song.id);
    setLaunching(true);
    window.setTimeout(() => {
      if (processing.current) setLaunching(false);
      else {
        store.prepareKaraoke(song.id, rehearsal ? "Rehearsal" : "AutoStart");
        navigate(routes.karaoke(song.id));
      }
    }, curtainMilliseconds);
  };

  return { startProcessing, resetAndReprocess, confirmDelete, showError, playSong, launching };
};
