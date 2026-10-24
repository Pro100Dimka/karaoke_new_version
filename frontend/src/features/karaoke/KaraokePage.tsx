import { canControlRoom } from "../../application/room/roomModel";
import "./karaoke.css";
import { Button, EmptyState, MessageBar, ProgressBar } from "@neo-ui-kit/react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useApp, useRoomPlayback } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { effectiveStageLayers } from "./displayModes";
import { KaraokeHeader } from "./KaraokeHeader";
import { KaraokeConsole } from "./console/KaraokeConsole";
import { useKaraokeShortcuts } from "./useKaraokeShortcuts";
import { useAutoHideConsole } from "./console/useAutoHideConsole";
import { rangeOf } from "./console/noteRange";
import { KaraokeIntro } from "./KaraokeIntro";
import { KaraokeStage } from "./KaraokeStage";
import { SceneBackdrop } from "./SceneBackdrop";
import { useKaraokeSession, type KaraokeOpenMode } from "./useKaraokeSession";
import { opensWithFullIntroduction } from "./karaokeOpenMode";
import { usePublishNowPlaying } from "../../app/desktop/shellBus";
import { HostWindowContext } from "../../shared/ui/hostWindow";
import { createPortal } from "react-dom";
import { useKaraokeTv } from "./tv/karaokeTv";
import type { AudioCapabilities } from "../../contracts/models";

export const microphoneAvailableForKaraoke = (
  capability: AudioCapabilities["microphone"],
  pitchHz: number | undefined,
): boolean => capability === "ready" || (pitchHz !== undefined && pitchHz > 0);

export const sceneVideoUrl = (
  mode: KaraokeOpenMode,
  preferredUrl: string | undefined,
  songUrl: string | undefined,
): string =>
  mode === "RoomPrepared"
    ? songUrl || preferredUrl || ""
    : preferredUrl || songUrl || "";

export const parseKaraokeMode = (state: unknown): KaraokeOpenMode => {
  const mode =
    state && typeof state === "object"
      ? (state as { mode?: unknown }).mode
      : undefined;
  return mode === "AutoStart" || mode === "Rehearsal" || mode === "RoomPrepared" ? mode : "Normal";
};

/** A song that cannot be sung: what happened, and the way back. */
const StateScreen = ({
  icon,
  title,
  body,
  children,
}: {
  icon: string;
  title: string;
  body: string;
  children: ReactNode;
}) => (
  <main className="karaokePage karaokeLoadState" role="alert">
    <EmptyState
      icon={icon}
      title={title}
      description={body}
      action={children}
    />
  </main>
);

/** Registers where the Karaoke route shows Karaoke (KaraokeHost renders it there). */
export const KaraokeSlotContext = createContext<(slot: HTMLElement | null) => void>(
  () => undefined,
);

/**
 * The Karaoke route only marks its place: KaraokeHost renders Karaoke into it, or into the TV, so
 * a session keeps playing while it moves between the two.
 */
export const KaraokePage = () => (
  <div className="karaokeSlot" ref={useContext(KaraokeSlotContext)} />
);

/** What the laptop drives while Karaoke is on the TV. */
export interface KaraokeScreenControls {
  /** Ends the song (the take is saved and analysed); null while there is nothing to end. */
  finish: (() => Promise<boolean>) | null;
}

interface KaraokeScreenProps {
  songId: string;
  mode: KaraokeOpenMode;
  /** Where Karaoke is drawn: the route's place or the TV; nothing is drawn while it has none. */
  target: HTMLElement | null;
  /** The window `target` belongs to: keys and pointer moves are read there. */
  host: Window;
  onTv: boolean;
  controls: MutableRefObject<KaraokeScreenControls | null>;
  onLeave(): void;
  onFinished(songId: string, takeId: string | undefined): void;
}

export const KaraokeScreen = ({
  songId,
  mode,
  target,
  host,
  onTv,
  controls,
  onLeave,
  onFinished,
}: KaraokeScreenProps) => {
  const { theme, openSettings, room } = useApp();
  const roomPlayback = useRoomPlayback();
  const notify = useNotify();
  const t = useText();
  const tv = useKaraokeTv();
  const opensWithIntro = opensWithFullIntroduction(mode);
  const [startReleased, setStartReleased] = useState(!opensWithIntro);
  const [introFinished, setIntroFinished] = useState(!opensWithIntro);
  const session = useKaraokeSession(songId, mode, startReleased);
  const { load, state } = session;

  const backToLibrary = async () => {
    if (!(await session.confirmExit())) return;
    if (room) {
      if (!canControlRoom(room)) {
        notify(t("errorRoomPermission"), "warning");
        return;
      }
      try {
        if (!roomPlayback) throw new Error("Room session unavailable");
        await roomPlayback.clearSong();
      } catch (error) {
        notify(
          t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"),
          "error",
        );
        return;
      }
    }
    onLeave();
  };

  const song = load.kind === "ready" ? load.song : null;
  // Escape on the TV brings Karaoke back to the laptop; on the laptop it leaves.
  useKaraokeShortcuts(
    session,
    song?.durationSeconds ?? 0,
    () => (onTv && tv ? tv.bringBack() : void backToLibrary()),
    host,
  );
  const capabilities = useMemo(
    () => ({
      hasLyrics: (session.document?.words.length ?? 0) > 0,
      hasNotes: (session.document?.notes.length ?? 0) > 0,
    }),
    [session.document],
  );
  const introduction = introFinished ? null : (
    <KaraokeIntro
      song={load.kind === "ready" ? load.song : null}
      ready={state.kind !== "preparing" && state.kind !== "recovering"}
      onStart={() => setStartReleased(true)}
      onDone={() => setIntroFinished(true)}
    />
  );
  const layers = effectiveStageLayers(
    { showNotes: session.showNotes, showLyrics: session.showLyrics },
    capabilities,
  );
  const autoHide = useAutoHideConsole(
    session.autoHideConsole,
    state.kind === "playing",
    host,
  );
  const range = useMemo(
    () => rangeOf((session.document?.notes ?? []).map((note) => note.pitch)),
    [session.document],
  );
  const microphoneReady = microphoneAvailableForKaraoke(
    session.capabilities.microphone,
    session.pitchHz,
  );
  const finishedSongId = state.kind === "finished" ? song?.id : undefined;
  const takeId = session.recordingId;
  const canFinish = ["ready", "playing", "paused"].includes(state.kind);
  // A layout effect: a song replacing this one on the TV takes over only after this one has let go.
  useLayoutEffect(() => {
    controls.current = { finish: canFinish ? session.finishPerformance : null };
    return () => {
      controls.current = null;
    };
  });
  useEffect(() => {
    if (onTv && song) host.document.title = song.title;
  }, [onTv, song, host]);
  // The taskbar, tray and Discord show this song; their play/pause buttons drive the same transport.
  usePublishNowPlaying(
    song
      ? {
          title: song.title,
          artist: song.artist,
          playing: state.kind === "playing",
          recording: session.recording === "recording",
          togglePlayback: session.togglePlay,
        }
      : null,
  );

  // Stop or the end of the song leads back to the library (or to the next song on the TV); a saved
  // take opens with its analysis.
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    if (finishedSongId) finished.current(finishedSongId, takeId);
  }, [finishedSongId, takeId]);

  // Drawn where the host puts it: the route's place in the app, or the TV window.
  const place = (node: ReactNode) =>
    target
      ? createPortal(
          <HostWindowContext.Provider value={host}>{node}</HostWindowContext.Provider>,
          target,
        )
      : null;

  if (load.kind === "loading") {
    return place(
      <main className="karaokePage karaokeLoadState" aria-live="polite">
        {introduction}
        <ProgressBar
          className="karaokeLoading"
          indeterminate
          label={t("loadingSong")}
        />
      </main>
    );
  }

  const back = (
    <Button icon="back" onClick={() => void backToLibrary()}>
      {t("library")}
    </Button>
  );

  if (load.kind === "notFound") {
    return place(
      <StateScreen
        icon="warning"
        title={t("songNotFound")}
        body={t("songNotFoundHint")}
      >
        {back}
      </StateScreen>
    );
  }
  if (load.kind === "notProcessed") {
    return place(
      <StateScreen
        icon="processing"
        title={t("songNotProcessed")}
        body={t("songNotProcessedHint")}
      >
        {back}
      </StateScreen>
    );
  }
  if (load.kind === "projectIssue") {
    const messages = {
      Upgradeable: "errorProjectUpgrade",
      Unsupported: "errorProjectUpgrade",
      TooNew: "errorProjectTooNew",
      Invalid: "errorProjectInvalid",
    } as const satisfies Record<typeof load.compatibility, MessageKey>;
    return place(
      <StateScreen
        icon="file"
        title={t("projectInvalid")}
        body={t(messages[load.compatibility])}
      >
        {back}
      </StateScreen>
    );
  }

  if (!song) return null;

  const scene = (
    <SceneBackdrop
      theme={theme}
      videoUrl={sceneVideoUrl(
        mode,
        session.songPrefs?.videoUrl,
        song.videoUrl,
      )}
      positionSeconds={session.position}
      playing={state.kind === "playing"}
      rate={session.speed}
    />
  );
  const stage = (
    <KaraokeStage
      songTitle={song.title}
      position={session.position}
      playing={state.kind === "playing"}
      rate={session.speed}
      keyShift={session.keyShift}
      document={session.document}
      layers={layers}
      vocalRange={session.songPrefs?.vocalRange ?? "auto"}
      pitchHz={session.pitchHz}
      pitchFrames={session.pitchFrames}
      onNoteScoreChange={session.updateKaraokeNoteScore}
    />
  );
  return place(
    <main className="karaokePage">
      {introduction}
      {scene}
      <KaraokeHeader
        inline={onTv}
        visible={autoHide.headerVisible && introFinished}
        consoleToggle={
          session.autoHideConsole
            ? null
            : {
                visible: autoHide.consoleVisible,
                onToggle: autoHide.toggleHidden,
              }
        }
        onBack={() => void backToLibrary()}
      />
      {state.kind === "failed" ? (
        <MessageBar
          tone="error"
          className="karaokeFailure"
          action={
            <>
              <Button
                size="sm"
                icon="settings"
                onClick={() => openSettings("audio")}
              >
                {t("openAudioSettings")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="refresh"
                onClick={() => window.location.reload()}
              >
                {t("retry")}
              </Button>
            </>
          }
        >
          {state.error.message}
        </MessageBar>
      ) : (
        stage
      )}
      <div className="karaokeConsole">
        {!microphoneReady && (
          <MessageBar tone="info">{t("noMicrophoneMode")}</MessageBar>
        )}
        <KaraokeConsole
          song={song}
          state={state}
          session={session}
          visible={autoHide.consoleVisible}
          hasNotes={capabilities.hasNotes}
          hasLyrics={capabilities.hasLyrics}
          range={range}
          microphoneAvailable={microphoneReady}
        />
      </div>
    </main>
  );
};
