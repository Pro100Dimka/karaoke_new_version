import { observer } from 'mobx-react-lite';
import { store } from '../../providers/store';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from '@neo-ui-kit/react';

import { karaokeOnTv, useDisplayCount } from '../../app/desktop/shellBus';
import { routes } from '../../shared/routes';
import type { KaraokeScreenControls } from './KaraokePage';
import { KaraokeSlotContext } from './karaokeSlot';
import {
  KaraokeTvContext,
  queueWith,
  type KaraokeTv,
  type QueuedSong,
} from './tv/karaokeTv';
import { useTvWindow } from './tv/useTvWindow';
import type { KaraokeOpenMode } from './useKaraokeSession';

const KaraokeScreen = lazy(() =>
  import('./KaraokePage').then((module) => ({ default: module.KaraokeScreen })),
);

interface TvPlayback {
  songId: string;
  mode: KaraokeOpenMode;
  queue: readonly QueuedSong[];
}

/**
 * Karaoke lives here rather than in its route, so it can move to a TV and back without the session
 * (audio, recording, scoring) starting over. Opened from the Karaoke route it is drawn in the route's
 * place; on the TV it is drawn there while the laptop shows the Library. The TV plays a queue: at
 * the end of a song the next one starts there, and the finished take's analysis opens on the laptop.
 */
export const KaraokeHost = observer(({ children }: { children: ReactNode }) => {
  const { pathname, params, navigate } = useRouter();
  const { room } = store.online;
  const displays = useDisplayCount();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [tv, setTv] = useState<TvPlayback | null>(null);
  const [ending, setEnding] = useState<{
    songId: string;
    takeId?: string;
  } | null>(null);
  const tvRef = useRef(tv);
  tvRef.current = tv;
  const controls = useRef<KaraokeScreenControls | null>(null);

  const routeSongId = pathname.startsWith('/karaoke/')
    ? params.songId
    : undefined;
  const launch = store.playback.launch;
  const routeMode =
    launch && launch.songId === routeSongId ? launch.mode : 'Normal';
  const route = useRef({ songId: routeSongId, mode: routeMode });
  route.current = { songId: routeSongId, mode: routeMode };

  // Closing the TV window (Alt+F4, Escape) brings Karaoke back to the laptop.
  const bringBackRef = useRef(() => undefined as void);
  const tvWindow = useTvWindow(() => bringBackRef.current());
  const { close: closeTv, open: openTv } = tvWindow;

  const endTv = useCallback(() => {
    setTv(null);
    closeTv();
  }, [closeTv]);

  const bringBack = useCallback(() => {
    const current = tvRef.current;
    if (!current) return;
    // Navigation is a React transition: retain the session until the karaoke route commits.
    // The pathname effect closes the TV afterwards, without an empty Library render in between.
    store.prepareKaraoke(current.songId, current.mode);
    navigate(routes.karaoke(current.songId));
  }, [navigate]);
  bringBackRef.current = bringBack;

  const send = useCallback(() => {
    const { songId, mode } = route.current;
    if (!songId || tvRef.current) return;
    if (!openTv('A&D Voice')) return;
    setTv({ songId, mode, queue: [] });
    navigate(routes.library);
  }, [openTv, navigate]);

  const finished = useCallback(
    (songId: string, takeId: string | undefined) => {
      const analysis = takeId
        ? { analysisSongId: songId, analysisFor: takeId }
        : undefined;
      const current = tvRef.current;
      if (!current) {
        const next = store.advancePlaylist(songId);
        if (next) {
          store.prepareKaraoke(next, 'AutoStart');
          navigate(routes.karaoke(next));
          return;
        }
        setEnding({ songId, takeId });
        return;
      }
      const [next, ...rest] = current.queue;
      const nextId = next?.id ?? store.advancePlaylist(songId);
      if (next) store.cancelPlaylist();
      if (nextId)
        setTv({
          songId: nextId,
          mode: next?.rehearsal ? 'Rehearsal' : 'AutoStart',
          queue: rest,
        });
      else endTv();
      if (analysis) {
        store.returnFromKaraoke(analysis);
        navigate(routes.library, true);
      }
    },
    [endTv, navigate],
  );

  useEffect(() => {
    if (!ending || room?.playlist) return;
    const timer = window.setTimeout(
      () => {
        store.returnFromKaraoke({
          performanceReturn: true,
          ...(ending.takeId
            ? { analysisSongId: ending.songId, analysisFor: ending.takeId }
            : {}),
        });
        navigate(routes.library);
        setEnding(null);
      },
      room ? 400 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [ending, navigate, room]);

  const leave = useCallback(() => {
    store.cancelPlaylist();
    if (tvRef.current) endTv();
    else navigate(routes.library);
  }, [endTv, navigate]);

  const play = useCallback((song: QueuedSong, when: 'next' | 'now') => {
    const current = tvRef.current;
    if (!current || song.id === current.songId) return;
    const queue = queueWith(current.queue, song, when);
    const finish = when === 'now' ? controls.current?.finish : null;
    // Right away: the current song ends as with Stop (its take is kept) and the queue moves on.
    if (when === 'now' && !finish)
      setTv({
        songId: song.id,
        mode: song.rehearsal ? 'Rehearsal' : 'AutoStart',
        queue: queue.slice(1),
      });
    else setTv({ ...current, queue });
    if (finish) void finish();
  }, []);

  const stop = useCallback(() => {
    const finish = controls.current?.finish;
    if (finish) void finish();
    else endTv();
  }, [endTv]);

  // A room uses everyone's own screen. Leaving the Library also ends the TV session.
  useEffect(() => {
    if (room) store.cancelPlaylist();
    if (tvRef.current && (room || pathname !== routes.library)) endTv();
  }, [room, pathname, endTv]);

  const active = tv !== null;
  useEffect(() => karaokeOnTv.set(active), [active]);
  useEffect(() => () => karaokeOnTv.set(false), []);

  const value = useMemo<KaraokeTv>(
    () => ({
      available: displays > 1 && !room,
      active,
      songId: tv?.songId ?? null,
      queue: tv?.queue ?? [],
      send,
      bringBack,
      stop,
      play,
    }),
    [displays, room, active, tv, send, bringBack, stop, play],
  );

  const shown =
    tv ?? (routeSongId ? { songId: routeSongId, mode: routeMode } : null);
  const screen = tv ? tvWindow.screen : null;

  return (
    <KaraokeTvContext.Provider value={value}>
      <KaraokeSlotContext.Provider value={setSlot}>
        {children}
        {ending && !room?.playlist && (
          <div className="sceneCurtain" data-phase="closing" aria-hidden />
        )}
        {shown && (
          <Suspense fallback={null}>
            <KaraokeScreen
              key={shown.songId}
              songId={shown.songId}
              mode={shown.mode}
              target={tv ? (screen?.container ?? null) : slot}
              host={screen?.window ?? window}
              onTv={active}
              controls={controls}
              onLeave={leave}
              onFinished={finished}
            />
          </Suspense>
        )}
      </KaraokeSlotContext.Provider>
    </KaraokeTvContext.Provider>
  );
});
