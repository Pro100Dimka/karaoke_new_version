import { Button, Dialog, Select, TextField, tr } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { SongDto } from '../../contracts/models';
import { useNotify } from '../../providers/notifications';
import { store } from '../../providers/store';
import type { KaraokePlaylist } from '../../shared/preferences/preferences';
import './playlists.css';

type PlaylistSong = Pick<
  SongDto,
  'id' | 'title' | 'artist' | 'status' | 'activeRevision'
>;

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
    const catalog = new Map(songs.map((song) => [song.id, song]));
    const ordered = songIds.map((songId) => catalog.get(songId));
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
    const move = (index: number, direction: number) => {
      const next = [...songIds];
      const current = next[index];
      const adjacent = next[index + direction];
      if (current === undefined || adjacent === undefined) return;
      next[index] = adjacent;
      next[index + direction] = current;
      setSongIds(next);
    };
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
                <ol className="playlistSongs">
                  {songIds.map((songId, index) => {
                    const song = catalog.get(songId);
                    return (
                      <li
                        key={songId}
                        className="playlistSong"
                        data-unavailable={
                          !song || song.status !== 'ready' || undefined
                        }
                      >
                        <span className="playlistNumber">{index + 1}</span>
                        <span className="playlistSongTitle">
                          <strong>
                            {song?.title ?? tr('playlistUnavailable')}
                          </strong>
                          <small>{song?.artist}</small>
                        </span>
                        <div className="playlistSongActions">
                          <Button
                            aria-label={tr('playlistMoveUp')}
                            disabled={busy || index === 0}
                            onClick={() => move(index, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            aria-label={tr('playlistMoveDown')}
                            disabled={busy || index === songIds.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            ↓
                          </Button>
                          <Button
                            icon="close"
                            aria-label={tr('playlistRemove')}
                            disabled={busy}
                            onClick={() =>
                              setSongIds(
                                songIds.filter((value) => value !== songId),
                              )
                            }
                          />
                        </div>
                      </li>
                    );
                  })}
                </ol>
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
