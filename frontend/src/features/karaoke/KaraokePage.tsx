import { canControlRoom } from "../../application/room/roomModel";
import "./karaoke.css";
import { Button, EmptyState, MessageBar, ProgressBar } from "@neo-ui-kit/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useApp, useRoomPlayback } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { routes } from "../../shared/routes";
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
import { usePublishNowPlaying, useDisplayCount } from "../../app/desktop/shellBus";
import { useStageScreen } from "../../shared/ui/useStageScreen";
import { createPortal } from "react-dom";
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

const parseMode = (state: unknown): KaraokeOpenMode => {
  const mode =
    state && typeof state === "object"
      ? (state as { mode?: unknown }).mode
      : undefined;
  return mode === "AutoStart" || mode === "RoomPrepared" ? mode : "Normal";
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

export const KaraokePage = () => {
  const { songId = "" } = useParams<{ songId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, openSettings, room } = useApp();
  const roomPlayback = useRoomPlayback();
  const notify = useNotify();
  const t = useText();
  const mode = parseMode(location.state);
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
    navigate(routes.library);
  };

  const song = load.kind === "ready" ? load.song : null;
  useKaraokeShortcuts(
    session,
    song?.durationSeconds ?? 0,
    () => void backToLibrary(),
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
  // The stage (scene and lyrics) can move to a second screen; the laptop keeps the console.
  const stageScreen = useStageScreen(song?.title ?? "A&D Voice");
  const displays = useDisplayCount();
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

  // Stop or the end of the song leads back to the library; a saved take opens with its analysis.
  useEffect(() => {
    if (!finishedSongId) return;
    navigate(routes.library, {
      state: takeId
        ? { analysisSongId: finishedSongId, analysisFor: takeId }
        : undefined,
    });
  }, [finishedSongId, takeId, navigate]);

  if (load.kind === "loading") {
    return (
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
    return (
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
    return (
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
    return (
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
      onNoteScoreChange={session.updateKaraokeNoteScore}
    />
  );
  // On a second screen the scene and the lyrics move there (nothing is drawn twice); the laptop keeps
  // the header and the console, with a note where the stage went.
  const onSecondScreen = stageScreen.container;

  return (
    <main className="karaokePage">
      {introduction}
      {onSecondScreen
        ? createPortal(
            <div className="karaokePage stageScreenPage">
              {scene}
              {state.kind !== "failed" && stage}
            </div>,
            onSecondScreen,
          )
        : scene}
      <KaraokeHeader
        stageScreen={{
          available: displays > 1,
          active: stageScreen.active,
          onToggle: () => (stageScreen.active ? stageScreen.close() : stageScreen.open()),
        }}
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
      ) : onSecondScreen ? (
        <MessageBar
          tone="info"
          className="stageScreenNotice"
          action={
            <Button size="sm" icon="window" onClick={stageScreen.close}>
              {t("stageScreenReturn")}
            </Button>
          }
        >
          {t("stageScreenActive")}
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
