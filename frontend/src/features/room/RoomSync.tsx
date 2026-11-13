import { tr, useLocale, useRouter } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { store } from '../../providers/store';

import { getRoomRuntime, roomSession } from '../../providers/application';
import {
  playNotificationSound,
  useNotify,
} from '../../providers/notifications';

import type { RoomChimeKind } from '../../application/room/roomChime';
import chimeUrlJoin from '../../assets/sounds/room-join.mp3';
import chimeUrlLeave from '../../assets/sounds/room-leave.mp3';
import { routes } from '../../shared/routes';

const chimeUrls = { join: chimeUrlJoin, leave: chimeUrlLeave } satisfies Record<
  RoomChimeKind,
  string
>;

/** Adapts room application events to navigation, notices, and the scene curtain. */
export const RoomSync = observer(() => {
  const runtime = getRoomRuntime();
  const { preferences } = store;
  const { room } = store.online;
  const lastRoom = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (room?.code && room.code !== lastRoom.current)
      playNotificationSound('success');
    lastRoom.current = room?.code;
  }, [room?.code]);
  const { python } = store.application.services;
  const notify = useNotify();
  useLocale();
  const { navigate, pathname } = useRouter();
  const [launching, setLaunching] = useState(false);
  const latest = useRef({ pathname, notify, navigate });
  latest.current = { pathname, notify, navigate };

  useEffect(() => {
    runtime.attach({
      pathname: () => latest.current.pathname,
      navigate: (songId) => {
        store.prepareKaraoke(songId, 'RoomPrepared');
        latest.current.navigate(routes.karaoke(songId));
      },
      curtain: setLaunching,
      notify: (key, tone, params) =>
        latest.current.notify(tr(key as string, params), tone, {
          silent: key === 'participantJoined' || key === 'participantLeft',
        }),
      chime: (kind) => {
        void new Audio(chimeUrls[kind]).play().catch(() => undefined);
      },
    });
    return () => runtime.detach();
  }, [runtime]);

  useEffect(
    () => runtime.setPythonReady(python.kind === 'ready'),
    [runtime, python.kind],
  );
  useEffect(() => {
    if (python.kind === 'ready')
      void roomSession.restore(preferences.displayName);
  }, [roomSession, python.kind, preferences.displayName]);
  useEffect(
    () => runtime.setPersistedBackend(preferences.audio.backend),
    [runtime, preferences.audio.backend],
  );

  return launching ? <div className="roomSceneCurtain" aria-hidden /> : null;
});
