import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { refreshSongs, type SongPage } from "../../../api/api-service";
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
import { ask } from "../../../providers/dialog";
import { useNotify } from "../../../providers/notifications";
import type { SongDto } from "../../../contracts/models";
import { ru } from "../../../i18n/messages.ru";
import { useGuardedAction } from "./useGuardedAction";

/** Confirmation shared by the card and song settings. */
export const useSongActions = (onDeleted?: () => void) => {
  const client = useQueryClient();
  const notify = useNotify();
  useLocale();
  const guarded = useGuardedAction();

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
      await catalog.deleteSong(song.id);
      await refreshSongs(client);
      onDeleted?.();
      notify(tr(ru.songDeleted), "success");
    });
  };

  return { confirmDelete };
};

export const useSongPlayback = ({ roomLibrary, navigate, tv }: {
  roomLibrary: ReturnType<typeof useRoomLibrary>;
  navigate(path: string): void;
  tv?: KaraokeTv | null;
}) => {
  const client = useQueryClient();
  const notify = useNotify();
  const [launching, setLaunching] = useState(false);
  const processing = useRef(store.application.localProcessing);
  processing.current = store.application.localProcessing;
  // While someone sings on the TV a chosen song waits its turn there, or replaces the current one.
  const playOnTv = async (song: SongDto, rehearsal = false) => {
    if (!tv) return;
    const current = client.getQueriesData<InfiniteData<SongPage>>({ queryKey: ["songs"] })
      .flatMap(([, data]) => data?.pages.flatMap(page => page.items) ?? [])
      .find(item => item.id === tv.songId);
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

  return { playSong, launching };
};
