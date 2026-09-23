import "./karaoke.css";
import { Spinner } from "../../shared/ui/Spinner";
import { Alert } from "../../shared/ui/Alert";
import { Button } from "../../theme/ui";
import { AlertTriangle, ArrowLeft, FileWarning, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { useNotify } from "../../app/NotificationsProvider";
import { routes } from "../../app/routes";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { roomClient } from "../../services/roomClient";
import { errorMessageKey, toAppError } from "../../shared/errors";
import { effectiveStageLayers } from "./displayModes";
import { KaraokeHeader } from "./KaraokeHeader";
import { KaraokeConsole } from "./console/KaraokeConsole";
import { useAutoHideConsole } from "./console/useAutoHideConsole";
import { rangeOf } from "./console/noteRange";
import { KaraokeIntro } from "./KaraokeIntro";
import { KaraokeStage } from "./KaraokeStage";
import { SceneBackdrop } from "./SceneBackdrop";
import { useKaraokeSession, type KaraokeOpenMode } from "./useKaraokeSession";

const parseMode = (state: unknown): KaraokeOpenMode => {
  const mode = state && typeof state === "object" ? (state as { mode?: unknown }).mode : undefined;
  return mode === "AutoStart" || mode === "RoomPrepared" ? mode : "Normal";
};

const isTextEntry = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) || target.getAttribute("role") === "slider";
};

const StateScreen = ({
  icon,
  title,
  body,
  children
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
}) => (
  <main className="karaokePage karaokeLoadState" role="alert">
    {icon}
    <h1>{title}</h1>
    <p>{body}</p>
    <div className="modalActions">{children}</div>
  </main>
);

export const KaraokePage = () => {
  const { songId = "" } = useParams<{ songId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, openSettings, room, setRoom } = useApp();
  const notify = useNotify();
  const t = useText();
  const mode = parseMode(location.state);
  const [startReleased, setStartReleased] = useState(mode !== "AutoStart");
  const [introFinished, setIntroFinished] = useState(mode !== "AutoStart");
  const session = useKaraokeSession(songId, mode, startReleased);
  const { load, state } = session;

  const backToLibrary = async () => {
    if (!(await session.confirmExit())) return;
    if (room) {
      if (room.role !== "host") {
        notify(t("errorRoomPermission"), "warning");
        return;
      }
      try {
        setRoom(await roomClient.clearRoomSong(room.code));
      } catch (error) {
        notify(t(errorMessageKey(toAppError(error)) ?? "roomNetworkUnavailable"), "error");
        return;
      }
    }
    navigate(routes.library);
  };

  // Space toggles playback unless focus is in an editable or self-activating control.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTextEntry(event.target)) return;
      event.preventDefault();
      void session.togglePlay();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [session]);

  const song = load.kind === "ready" ? load.song : null;
  const capabilities = useMemo(
    () => ({
      hasLyrics: (session.document?.words.length ?? 0) > 0,
      hasNotes: (session.document?.notes.length ?? 0) > 0
    }),
    [session.document]
  );
  const introduction = introFinished ? null : (
    <KaraokeIntro song={load.kind === "ready" ? load.song : null} onStart={() => setStartReleased(true)} onDone={() => setIntroFinished(true)} />
  );
  const layers = effectiveStageLayers({ showNotes: session.showNotes, showLyrics: session.showLyrics }, capabilities);
  const autoHide = useAutoHideConsole(session.autoHideConsole, state.kind === "playing");
  const range = useMemo(() => rangeOf((session.document?.notes ?? []).map(note => note.pitch)), [session.document]);
  const microphoneReady = session.capabilities.microphone === "ready";
  const finishedSongId = state.kind === "finished" ? song?.id : undefined;
  const takeId = session.recordingId;

  // Stop or the end of the song leads back to the library; a saved take opens with its analysis.
  useEffect(() => {
    if (!finishedSongId) return;
    navigate(routes.library, { state: takeId ? { openRecordingsFor: finishedSongId, analysisFor: takeId } : undefined });
  }, [finishedSongId, takeId, navigate]);

  if (load.kind === "loading") {
    return (
      <main className="karaokePage karaokeLoadState" aria-live="polite">
        {introduction}
        <LoaderCircle aria-hidden className="spin" size={32} />
        <Spinner label={t("loadingSong")} />
      </main>
    );
  }

  const back = (
    <Button startIcon={<ArrowLeft size={16} />} onClick={() => void backToLibrary()}>
      {t("library")}
    </Button>
  );

  if (load.kind === "notFound") {
    return <StateScreen icon={<AlertTriangle aria-hidden size={36} />} title={t("songNotFound")} body={t("songNotFoundHint")}>{back}</StateScreen>;
  }
  if (load.kind === "notProcessed") {
    return <StateScreen icon={<AlertTriangle aria-hidden size={36} />} title={t("songNotProcessed")} body={t("songNotProcessedHint")}>{back}</StateScreen>;
  }
  if (load.kind === "projectIssue") {
    const messages = {
      Upgradeable: "errorProjectUpgrade",
      Unsupported: "errorProjectUpgrade",
      TooNew: "errorProjectTooNew",
      Invalid: "errorProjectInvalid"
    } as const satisfies Record<typeof load.compatibility, MessageKey>;
    return <StateScreen icon={<FileWarning aria-hidden size={36} />} title={t("projectInvalid")} body={t(messages[load.compatibility])}>{back}</StateScreen>;
  }

  if (!song) return null;
  const duration = song.durationSeconds;

  return (
    <main className="karaokePage">
      {introduction}
      <SceneBackdrop
        theme={theme}
        videoUrl={session.songPrefs?.videoUrl || song.videoUrl || ""}
        positionSeconds={session.position}
        playing={state.kind === "playing"}
        rate={session.speed}
      />
      <KaraokeHeader
        visible={autoHide.headerVisible && introFinished}
        consoleToggle={session.autoHideConsole ? null : { visible: autoHide.consoleVisible, onToggle: autoHide.toggleHidden }}
        onBack={() => void backToLibrary()}
      />
      {state.kind === "failed" ? (
        <Alert
          intent="error"
          actions={
            <>
              <Button size="sm" variant="outlined" tone="neutral" onClick={() => openSettings("audio")}>
                {t("openAudioSettings")}
              </Button>
              <Button size="sm" onClick={() => window.location.reload()}>
                {t("retry")}
              </Button>
            </>
          }
        >
          {state.error.message}
        </Alert>
      ) : (
        <KaraokeStage
          songTitle={song.title}
          position={session.position}
          playing={state.kind === "playing"}
          rate={session.speed}
          document={session.document}
          layers={layers}
          vocalRange={session.songPrefs?.vocalRange ?? "auto"}
        />
      )}
      <div className="karaokeConsole">
        {!microphoneReady && (
          <Alert intent="info">{t("noMicrophoneMode")}</Alert>
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
