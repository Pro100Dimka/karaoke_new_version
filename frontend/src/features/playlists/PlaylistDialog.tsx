import {
  Button,
  Dialog,
  Select,
  TextField,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { computed } from 'mobx';
import { useCallback, useMemo, useState } from 'react';
import type { SongDto } from '../../contracts/models';
import { useNotify } from '../../providers/notifications';
import { store } from '../../providers/store';
import type { KaraokePlaylist } from '../../shared/preferences/preferences';
import './playlists.css';

type PlaylistSong = Pick<
  SongDto,
  'id' | 'title' | 'artist' | 'status' | 'activeRevision'
>;

/** Name edits do not change the song controls; keep that large subtree stable. */
const PlaylistSongs = observer(
  ({
    songIds,
    catalog,
    busy,
    onMove,
    onRemove,
  }: {
    songIds: readonly string[];
    catalog: ReadonlyMap<string, PlaylistSong>;
    busy: boolean;
    onMove(index: number, direction: number): void;
    onRemove(songId: string): void;
  }) => {
    useLocale();
    return (
      <ol className="playlistSongs">
        {songIds.map((songId, index) => {
          const song = catalog.get(songId);
          return (
            <li
              key={songId}
              className="playlistSong"
              data-unavailable={!song || song.status !== 'ready' || undefined}
            >
              <span className="playlistNumber">{index + 1}</span>
              <span className="playlistSongTitle">
                <strong>{song?.title ?? tr('playlistUnavailable')}</strong>
                <small>{song?.artist}</small>
              </span>
              <div className="playlistSongActions">
                <Button
                  aria-label={tr('playlistMoveUp')}
                  disabled={busy || index === 0}
                  onClick={() => onMove(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  aria-label={tr('playlistMoveDown')}
                  disabled={busy || index === songIds.length - 1}
                  onClick={() => onMove(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  icon="close"
                  aria-label={tr('playlistRemove')}
                  disabled={busy}
                  onClick={() => onRemove(songId)}
                />
              </div>
            </li>
          );
        })}
      </ol>
    );
  },
);

export const PlaylistDialog = observer(
  ({
    songs,
    onClose,
    onPlay,
    disabled,
  }: {
    songs: readonly PlaylistSong[];
    onClose(): void;
    onPlay(
      playlist: KaraokePlaylist,
      songs: PlaylistSong[],
    ): Promise<void> | void;
    disabled?: boolean;
  }) => {
    const saved = store.preferences.karaokePlaylists;
    const [id, setId] = useState(saved[0]?.id ?? '');
    const [name, setName] = useState(saved[0]?.name ?? '');
    const [songIds, setSongIds] = useState(saved[0]?.songIds ?? []);
    const [busy, setBusy] = useState(false);
    const notify = useNotify();
    // Keep observing collections that MobX can update without replacing them.
    const catalog = useMemo(
      () => computed(() => new Map(songs.map((song) => [song.id, song]))),
      [songs],
    ).get();
    const ordered = useMemo(
      () => computed(() => songIds.map((songId) => catalog.get(songId))),
      [songIds, catalog],
    ).get();
    const ready = ordered.flatMap((song) =>
      song?.status === 'ready' ? [song] : [],
    );
    const choose = (value: string) => {
      const playlist = saved.find((item) => item.id === value);
      setId(playlist?.id ?? '');
      setName(playlist?.name ?? '');
      setSongIds(playlist?.songIds ?? []);
    };
    const save = () => {
      const playlist = {
        id,
        name: name.trim(),
        songIds,
      };
      store.updatePreferences({
        karaokePlaylists: saved.map((item) =>
          item.id === id ? playlist : item,
        ),
      });
      setId(playlist.id);
      return playlist;
    };
    const move = useCallback((index: number, direction: number) => {
      setSongIds((ids) => {
        const current = ids[index];
        const adjacent = ids[index + direction];
        if (current === undefined || adjacent === undefined) return ids;
        const next = [...ids];
        next[index] = adjacent;
        next[index + direction] = current;
        return next;
      });
    }, []);
    const remove = useCallback((songId: string) => {
      setSongIds((ids) => ids.filter((value) => value !== songId));
    }, []);
    const play = async () => {
      setBusy(true);
      try {
        await onPlay(save(), ready);
        onClose();
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        setBusy(false);
      }
    };
    return (
      <Dialog
        open
        title={tr('playlists')}
        icon="list"
        width="large"
        cancelLabel={false}
        confirmLabel={false}
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <div className="playlistEditor" aria-busy={busy}>
          {!saved.length ? (
            <p className="playlistHint">{tr('playlistEmpty')}</p>
          ) : (
            <>
              <div className="playlistToolbar">
                <Select
                  label={tr('playlistSaved')}
                  value={id}
                  options={[
                    ...saved.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                  onValueChange={choose}
                  disabled={busy}
                />
                <Button
                  icon="trash"
                  disabled={!id || busy}
                  onClick={() => {
                    store.updatePreferences({
                      karaokePlaylists: saved.filter((item) => item.id !== id),
                    });
                    choose(saved.find((item) => item.id !== id)?.id ?? '');
                  }}
                >
                  {tr('Удалить')}
                </Button>
              </div>
              <TextField
                label={tr('playlistName')}
                value={name}
                maxLength={100}
                onValueChange={setName}
                disabled={busy}
              />
              <p className="playlistHint">{tr('playlistHint')}</p>
              <section>
                <h3>
                  {tr('playlistOrder')} · {songIds.length}
                </h3>
                <PlaylistSongs
                  songIds={songIds}
                  catalog={catalog}
                  busy={busy}
                  onMove={move}
                  onRemove={remove}
                />
                {!songIds.length && (
                  <p className="playlistHint">{tr('playlistEmpty')}</p>
                )}
              </section>
              {ready.length !== songIds.length && (
                <p role="status">{tr('playlistUnavailableHint')}</p>
              )}
              {disabled && store.online.room?.songId && (
                <p role="status">{tr('playlistRoomBusy')}</p>
              )}
              <div className="playlistFooter">
                <Button disabled={busy || !name.trim()} onClick={save}>
                  {tr('save')}
                </Button>
                <Button
                  icon="play"
                  variant="primary"
                  disabled={
                    busy ||
                    disabled ||
                    !name.trim() ||
                    !songIds.length ||
                    ready.length !== songIds.length
                  }
                  onClick={() => void play()}
                >
                  {tr('playlistPlay')}
                </Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    );
  },
);

export const AddToPlaylistDialog = observer(
  ({
    songIds,
    onClose,
    onAdded,
  }: {
    songIds: string[];
    onClose(): void;
    onAdded(): void;
  }) => {
    const saved = store.preferences.karaokePlaylists;
    const [id, setId] = useState(saved[0]?.id ?? '');
    const [name, setName] = useState('');
    const notify = useNotify();
    const existing = saved.find((item) => item.id === id);
    const merged = [...new Set([...(existing?.songIds ?? []), ...songIds])];
    const added = merged.length - (existing?.songIds.length ?? 0);
    const save = () => {
      const playlist = {
        id: existing?.id ?? crypto.randomUUID(),
        name: existing?.name ?? name.trim(),
        songIds: merged,
      };
      store.updatePreferences({
        karaokePlaylists: existing
          ? saved.map((item) => (item.id === existing.id ? playlist : item))
          : [...saved, playlist],
      });
      notify(tr('playlistAdded', { count: added }), 'success');
      onAdded();
      onClose();
    };
    return (
      <Dialog
        open
        title={tr('playlistAddTo')}
        icon="list"
        width="narrow"
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        confirmLabel={false}
        cancelLabel={false}
      >
        <div className="playlistEditor">
          <Select
            label={tr('playlistDestination')}
            value={id}
            options={[
              ...saved.map((item) => ({ value: item.id, label: item.name })),
              { value: '', label: tr('playlistNew') },
            ]}
            onValueChange={setId}
          />
          {!existing && (
            <TextField
              label={tr('playlistName')}
              value={name}
              maxLength={100}
              onValueChange={setName}
            />
          )}
          {merged.length > 200 && <p role="status">{tr('playlistLimit')}</p>}
          <div className="playlistFooter">
            <Button onClick={onClose}>{tr('cancel')}</Button>
            <Button
              variant="primary"
              disabled={
                !songIds.length ||
                !added ||
                merged.length > 200 ||
                (!existing && !name.trim())
              }
              onClick={save}
            >
              {tr(existing ? 'playlistAddTo' : 'playlistCreateAndAdd')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  },
);
