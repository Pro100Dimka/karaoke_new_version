import { useEffect, useRef } from "react";
import type { RoomStateDto } from "../../contracts/models";
import { audioClient, getAudioSnapshot } from "../../services/audioClient";
import type { KaraokeState } from "./karaokeMachine";
import { roomPlaybackSnapshotKey, synchronizeRoomPlayback } from "./roomPlayback";
import { createLatestSnapshotQueue, type LatestSnapshotQueue } from "../room/latestSnapshotQueue";

interface Options {
  room: RoomStateDto | null;
  ready: boolean;
  stateKind: KaraokeState["kind"];
  onEvent(event: "PLAY" | "PAUSE"): void;
  onFinished(): void;
  onFailure(error: unknown): void;
}

export const useSynchronizedRoomPlayback = (options: Options): void => {
  const current = useRef(options);
  current.current = options;
  const pending = useRef<LatestSnapshotQueue<() => Promise<void>> | null>(null);
  const scheduledUntil = useRef(0);
  if (!pending.current) pending.current = createLatestSnapshotQueue(run => run());
  const { room, ready, stateKind } = options;
  const key = room ? roomPlaybackSnapshotKey(room) : "";
  const received = useRef({ key: "", at: 0, serverNow: NaN });
  if (received.current.key !== key) received.current = {
    key, at: performance.now(),
    serverNow: room?.serverClockOffsetMilliseconds === undefined
      ? Date.parse(room?.serverNow ?? "")
      : performance.now() + room.serverClockOffsetMilliseconds,
  };
  const preparing = stateKind === "preparing";

  useEffect(() => {
    const snapshot = current.current.room;
    if (!snapshot || !ready || preparing) {
      pending.current?.push(async () => {
        if (scheduledUntil.current === 0) return;
        scheduledUntil.current = 0;
        try {
          if ((await getAudioSnapshot()).state === "playing") await audioClient.pause();
        } catch (error) {
          current.current.onFailure(error);
        }
      });
      return;
    }
    const anchor = received.current;
    let timer: number | undefined;
    let active = true;
    const emit = (event: "PLAY" | "PAUSE" | "FINISH") => {
      if (!active) return;
      if (event === "FINISH") current.current.onFinished();
      else current.current.onEvent(event);
    };
    const apply = () => pending.current?.push(async () => {
      try {
        if (!active) return;
        const latest = current.current;
        const native = await getAudioSnapshot();
        if (!active) return;
        const timedSnapshot = Number.isFinite(anchor.serverNow) ? {
          ...snapshot,
          serverNow: new Date(anchor.serverNow + performance.now() - anchor.at).toISOString(),
          serverClockOffsetMilliseconds: undefined,
        } : snapshot;
        const delay = await synchronizeRoomPlayback(
          timedSnapshot, latest.stateKind, native.positionSeconds, audioClient, emit, () => active,
          native.state,
        );
        scheduledUntil.current = delay === undefined ? 0 : performance.now() + delay;
        if (active && delay !== undefined) timer = window.setTimeout(() => void apply(), delay);
      } catch (error) {
        if (active) current.current.onFailure(error);
      }
    });
    void apply();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, ready, preparing]);
};
