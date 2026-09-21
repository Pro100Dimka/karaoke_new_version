import type { AppError } from "../../contracts/models";

/** The one closed lifecycle of a Karaoke session; never modelled as independent flags. */
export type KaraokeState =
  | { kind: "preparing" }
  | { kind: "ready" }
  | { kind: "playing" }
  | { kind: "paused" }
  | { kind: "recovering" }
  | { kind: "stopping" }
  | { kind: "finished" }
  | { kind: "failed"; error: AppError };

export type KaraokeEvent =
  | { type: "PREPARED" }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "AUDIO_LOST" }
  | { type: "AUDIO_RECOVERED" }
  | { type: "STOPPING" }
  | { type: "FINISH" }
  | { type: "RESTART" }
  | { type: "FAIL"; error: AppError };

type TransitionTable = Partial<
  Record<KaraokeState["kind"], Partial<Record<KaraokeEvent["type"], KaraokeState>>>
>;

const transitions: TransitionTable = {
  preparing: { PREPARED: { kind: "ready" } },
  ready: { PLAY: { kind: "playing" }, AUDIO_LOST: { kind: "recovering" }, STOPPING: { kind: "stopping" } },
  playing: {
    PAUSE: { kind: "paused" },
    AUDIO_LOST: { kind: "recovering" },
    STOPPING: { kind: "stopping" },
    FINISH: { kind: "finished" }
  },
  paused: {
    PLAY: { kind: "playing" },
    AUDIO_LOST: { kind: "recovering" },
    STOPPING: { kind: "stopping" },
    FINISH: { kind: "finished" }
  },
  // After recovery playback never resumes on its own: the session comes back paused.
  recovering: { AUDIO_RECOVERED: { kind: "paused" } },
  stopping: { FINISH: { kind: "finished" } },
  finished: { RESTART: { kind: "ready" } }
};

export const reduceKaraoke = (state: KaraokeState, event: KaraokeEvent): KaraokeState => {
  if (event.type === "FAIL") return { kind: "failed", error: event.error };
  return transitions[state.kind]?.[event.type] ?? state;
};

export const isSessionActive = (state: KaraokeState): boolean =>
  state.kind === "playing" || state.kind === "paused" || state.kind === "stopping";
