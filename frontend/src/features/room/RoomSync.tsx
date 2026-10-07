import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useApp, useRoomRuntime, useRoomSession } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { useServices } from "../../app/ServicesContext";
import chimeUrlJoin from "../../assets/sounds/room-join.mp3";
import chimeUrlLeave from "../../assets/sounds/room-leave.mp3";
import type { RoomChimeKind } from "../../application/room/roomChime";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { routes } from "../../shared/routes";

const chimeUrls = { join: chimeUrlJoin, leave: chimeUrlLeave } satisfies
  Record<RoomChimeKind, string>;

/** Adapts room application events to navigation, notices, and the scene curtain. */
export const RoomSync = () => {
  const runtime = useRoomRuntime();
  const { preferences } = useApp("preferences");
  const roomSession = useRoomSession();
  const { python } = useServices();
  const notify = useNotify();
  const t = useText();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [launching, setLaunching] = useState(false);
  const latest = useRef({ pathname, notify, t, navigate });
  latest.current = { pathname, notify, t, navigate };

  useEffect(() => {
    runtime.attach({
      pathname: () => latest.current.pathname,
      navigate: (songId) => latest.current.navigate(routes.karaoke(songId), {
        state: { mode: "RoomPrepared" },
      }),
      curtain: setLaunching,
      notify: (key, tone, params) =>
        latest.current.notify(latest.current.t(key as MessageKey, params), tone),
      chime: (kind) => {
        void new Audio(chimeUrls[kind]).play().catch(() => undefined);
      },
    });
    return () => runtime.detach();
  }, [runtime]);

  useEffect(() => runtime.setPythonReady(python.kind === "ready"), [runtime, python.kind]);
  useEffect(() => {
    if (python.kind === "ready") void roomSession.restore(preferences.displayName);
  }, [roomSession, python.kind, preferences.displayName]);
  useEffect(() => runtime.setPersistedBackend(preferences.audio.backend),
    [runtime, preferences.audio.backend]);

  return launching ? <div className="roomSceneCurtain" aria-hidden /> : null;
};
