import "./karaoke.css";
import { Spinner } from "../../shared/ui/Spinner";
import { Alert } from "../../shared/ui/Alert";
import { Button } from "../../theme/ui";
import { AlertTriangle, ArrowLeft, FileWarning, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useApp } from "../../app/AppContext";
import { routes } from "../../app/routes";
import type { MessageKey } from "../../i18n/messages";
import { useText } from "../../i18n/useText";
import { desktopClient } from "../../services/desktopClient";
import { availableDisplayModes, effectiveDisplayMode } from "./displayModes";
import { KaraokeHeader } from "./KaraokeHeader";
import { KaraokeConsole } from "./console/KaraokeConsole";
import { rangeOf } from "./console/noteRange";
import { FinishedBar, RecoveryBar } from "./KaraokeSessionControls";
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
  const { theme, openSettings } = useApp();
  const t = useText();
  const session = useKaraokeSession(songId, parseMode(location.state));
  const { load, state } = session;

  const backToLibrary = async () => {
    if (await session.confirmExit()) navigate(routes.library);
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
      hasNotes: (session.document?.notes.length ?? 0) > 0,
      hasLivePitch: false
    }),
    [session.document]
  );
  const mode = effectiveDisplayMode(session.displayMode, capabilities);
  const range = useMemo(() => rangeOf((session.document?.notes ?? []).map(note => note.pitch)), [session.document]);
  const microphoneReady = session.capabilities.microphone === "ready";

  if (load.kind === "loading") {
    return (
      <main className="karaokePage karaokeLoadState" aria-live="polite">
        <LoaderCircle aria-hidden className="spin" size={32} />
        <Spinner label={t("loadingSong")} />
      </main>
    );
  }

  const back = (
    <Button startIcon={<ArrowLeft size={16} />} onClick={() => navigate(routes.library)}>
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
  const finished = state.kind === "finished";
  const recovery = state.kind === "recovering" || (state.kind === "paused" && session.recoveredNotice);

  return (
    <main className="karaokePage">
      <SceneBackdrop
        theme={theme}
        videoUrl={session.songPrefs?.videoUrl ?? ""}
        positionSeconds={session.position}
        playing={state.kind === "playing"}
        rate={session.speed}
      />
      <KaraokeHeader song={song} state={state} speed={session.speed} keyShift={session.keyShift} onBack={() => void backToLibrary()} />
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
          document={session.document}
          mode={mode}
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
          displayMode={mode}
          availableModes={availableDisplayModes(capabilities)}
          range={range}
          microphoneAvailable={microphoneReady}
          onFullscreen={() => void desktopClient.toggleFullscreen()}
          onOpenSettings={() => openSettings("audio")}
        />
        {recovery && (
          <RecoveryBar
            recovering={state.kind === "recovering"}
            onResume={() => void session.resume()}
            onStop={() => void session.finishPerformance()}
            onAudioSettings={() => openSettings("audio")}
          />
        )}
        {finished && (
          <FinishedBar
            hasRecording={Boolean(session.recordingId)}
            hasAnalysis={session.analysis !== null}
            onRepeat={() => void session.repeat()}
            onLibrary={() => navigate(routes.library)}
            onOpenRecording={() => navigate(routes.library, { state: { openRecordingsFor: song.id } })}
            onOpenAnalysis={() => navigate(routes.library, { state: { openRecordingsFor: song.id, analysisFor: session.recordingId } })}
          />
        )}
      </div>
    </main>
  );
};
