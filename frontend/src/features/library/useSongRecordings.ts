import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { AnalysisDto, RecordingDto, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
import { audioClient } from "../../services/audioClient";
import { pythonClient } from "../../services/pythonClient";
import { useGuardedAction } from "./useGuardedAction";

/** Recordings and analysis for one song; also honours "open my take" navigation from a finished performance. */
export const useSongRecordings = (songs: readonly SongDto[], ready: boolean, onChanged: () => void) => {
  const location = useLocation();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const guarded = useGuardedAction();
  const [song, setSong] = useState<SongDto | null>(null);
  const [recordings, setRecordings] = useState<readonly RecordingDto[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const handled = useRef(false);

  const open = (target: SongDto) =>
    guarded(async () => {
      setRecordings(await pythonClient.listRecordings(target.id));
      setSong(target);
    });

  useEffect(() => {
    if (!ready || handled.current) return;
    const state: unknown = location.state;
    const value = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
    if (typeof value.openRecordingsFor !== "string") return;
    handled.current = true;
    const target = songs.find(item => item.id === value.openRecordingsFor);
    if (!target) return;
    void (async () => {
      try {
        setRecordings(await pythonClient.listRecordings(target.id));
        setSong(target);
        if (typeof value.analysisFor === "string") setAnalysis(await pythonClient.latestAnalysis(value.analysisFor));
      } catch {
        notify(t("actionFailed"), "error");
      }
    })();
  }, [ready, songs, location.state, notify, t]);

  const analyze = (recording: RecordingDto) =>
    guarded(async () => setAnalysis(await pythonClient.analyzeRecording(recording.id)));

  const play = (recording: RecordingDto) => guarded(async () => void (await audioClient.playRecording(recording.id)));

  const remove = (recording: RecordingDto) =>
    guarded(async () => {
      const choice = await ask({
        title: t("deleteRecordingTitle"),
        body: t("deleteRecordingBody"),
        actions: [
          { id: "cancel", label: t("cancel") },
          { id: "delete", label: t("recordingDelete"), appearance: "primary" }
        ]
      });
      if (choice !== "delete") return;
      await pythonClient.deleteRecording(recording.id);
      setRecordings(items => items.filter(item => item.id !== recording.id));
      onChanged();
    });

  return {
    song,
    recordings,
    analysis,
    open,
    analyze,
    play,
    remove,
    close: () => setSong(null),
    closeAnalysis: () => setAnalysis(null)
  };
};
