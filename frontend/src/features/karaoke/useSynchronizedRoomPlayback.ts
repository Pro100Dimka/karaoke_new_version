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

export const useSynchronizedRoomPlayback = (options: Options): void => {
  const current = useRef(options);
  current.current = options;
  const { room, ready, stateKind } = options;
  const key = room ? roomPlaybackSnapshotKey(room) : "";
  const received = useRef({ key, at: performance.now() });
  if (received.current.key !== key) received.current = { key, at: performance.now() };
  const preparing = stateKind === "preparing";

  useEffect(() => {
    const snapshot = current.current.room;
    if (!snapshot || !ready || preparing) return;
    const receivedAt = received.current.at;
    let timer: number | undefined;
    let active = true;
    const emit = (event: "PLAY" | "PAUSE" | "FINISH") => {
      if (!active) return;
      if (event === "FINISH") current.current.onFinished();
      else current.current.onEvent(event);
    };
    const apply = async () => {
      try {
        const now = Date.parse(snapshot.serverNow ?? "");
        const timedSnapshot = Number.isFinite(now) ? {
          ...snapshot, serverNow: new Date(now + performance.now() - receivedAt).toISOString(),
        } : snapshot;
        const latest = current.current;
        const delay = await synchronizeRoomPlayback(
          timedSnapshot, latest.stateKind, latest.position.current, audioClient, emit, () => active,
        );
        if (active && delay !== undefined) timer = window.setTimeout(() => void apply(), delay);
      } catch (error) {
        if (active) current.current.onFailure(error);
      }
    };
    void apply();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, ready, preparing]);
};
