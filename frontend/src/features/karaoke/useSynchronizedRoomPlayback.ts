import { useEffect, useRef, type RefObject } from "react";
import type { RoomStateDto } from "../../contracts/models";
import { audioClient } from "../../services/audioClient";
import type { KaraokeState } from "./karaokeMachine";
import { roomPlaybackSnapshotKey, synchronizeRoomPlayback } from "./roomPlayback";

interface Options {
  room: RoomStateDto | null;
  ready: boolean;
  stateKind: KaraokeState["kind"];
  position: RefObject<number>;
  onEvent(event: "PLAY" | "PAUSE"): void;
  onFinished(): void;
  onFailure(error: unknown): void;
}

export const useSynchronizedRoomPlayback = ({
  room, ready, stateKind, position, onEvent, onFinished, onFailure,
}: Options): void => {
  const timer = useRef<number | undefined>(undefined);
  const appliedKey = useRef("");

  useEffect(() => {
    if (!room || !ready || stateKind === "preparing") return;
    const key = roomPlaybackSnapshotKey(room);
    if (appliedKey.current === key) return;
    appliedKey.current = key;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    let active = true;
    const emit = (event: "PLAY" | "PAUSE" | "FINISH") => {
      if (!active) return;
      if (event === "FINISH") onFinished();
      else onEvent(event);
    };
    void synchronizeRoomPlayback(room, stateKind, position.current, audioClient, emit)
      .then(delay => {
        if (!active || delay === undefined) return;
        timer.current = window.setTimeout(() => {
          const atStart = { ...room, serverNow: room.playbackStartedAt };
          void synchronizeRoomPlayback(atStart, stateKind, position.current, audioClient, emit);
        }, delay);
      })
      .catch(onFailure);
    return () => {
      active = false;
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, [room?.code, room?.songId, room?.revision, room?.playbackState, room?.playbackStartedAt,
    room?.playbackPositionSeconds, room?.serverNow, room?.serverClockOffsetMilliseconds,
    ready, stateKind, position, onEvent, onFinished, onFailure]);
};
