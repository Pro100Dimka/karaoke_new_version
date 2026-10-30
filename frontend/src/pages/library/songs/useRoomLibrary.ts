import { store } from "../../../providers/store";
import { tr, useLocale } from "@neo-ui-kit/react";
import { useEffect } from "react";
import { useRoomLibraryCommands } from "../../../providers/application";
import { useNotify } from "../../../providers/notifications";
import type { SongDto } from "../../../contracts/models";
import { ru } from "../../../i18n/messages.ru";
import { sharedStateOf } from "../../../application/room/roomModel";
import { errorMessageKey, toAppError } from "../../../shared/errors";
import { canControlRoom, encodeSharedLibraryView, sharedLibraryView } from "../../../application/room/roomModel";
import type { LibraryFilters } from "../hero/actions";
import type { LibraryViewFilters } from "../hero/search-field";

interface RoomLibraryOptions {
  setQuery: (query: string) => void;
  setViewFilters: (update: (current: LibraryViewFilters) => LibraryViewFilters) => void;
}

const sameViewFilters = (left: LibraryViewFilters, right: LibraryViewFilters): boolean =>
  left.status === right.status &&
  left.language === right.language &&
  left.duration === right.duration &&
  left.artwork === right.artwork;

/** In a room the shared library view is authoritative: the local view follows it, and a member
 * who may control the room publishes its own changes for everyone. */
export const useRoomLibrary = ({ setQuery, setViewFilters }: RoomLibraryOptions) => {
  useLocale();
  const notify = useNotify();
  const { preferences, updatePreferences } = store;
  const { room } = store.online;
  const commands = useRoomLibraryCommands();
  const reportRoomError = (error: unknown) =>
    notify(tr(ru[errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"]), "error");

  useEffect(() => {
    if (!room) return;
    const { query, sort, direction, ...shared } = sharedLibraryView(room);
    setQuery(query);
    setViewFilters((current) => (sameViewFilters(current, shared) ? current : shared));
    if (preferences.librarySort !== sort || preferences.librarySortDirection !== direction)
      updatePreferences({ librarySort: sort, librarySortDirection: direction });
  }, [room, preferences.librarySort, preferences.librarySortDirection, updatePreferences]);

  /** Whether this member may change the library view (always outside a room). */
  const canChangeView = !room || canControlRoom(room);

  const publishView = (query: string, filters: LibraryFilters) => {
    if (!room || !canControlRoom(room)) return;
    void commands
      ?.publishSharedState({
        ...sharedStateOf(room),
        libraryQuery: query,
        ...encodeSharedLibraryView(filters),
      })
      .catch(() => undefined);
  };

  const selectSong = async (song: SongDto): Promise<void> => {
    if (!room || !canControlRoom(room)) return;
    try {
      await commands?.selectSong(song.id, song.activeRevision);
    } catch (error) {
      reportRoomError(error);
    }
  };

  const setCollaborativeControl = (enabled: boolean) => {
    if (!room || room.role !== "host") return;
    void commands?.setCollaborativeControl(enabled).catch(reportRoomError);
  };

  /** How a card shows the room's selection; only for members who may choose the song. */
  const songSelection = (song: SongDto) =>
    room && canControlRoom(room) && song.status === "ready"
      ? { role: room.role, selected: room.songId === song.id }
      : undefined;

  return { room, canChangeView, publishView, selectSong, setCollaborativeControl, songSelection };
};
