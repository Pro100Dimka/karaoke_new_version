import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type { AnalysisDto, RecordingDto, SongDto } from "../../contracts/models";
import { useText } from "../../i18n/useText";
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
    if (typeof value.analysisSongId !== "string" || typeof value.analysisFor !== "string") return;
    handled.current = true;
    const target = songs.find(item => item.id === value.analysisSongId);
    if (!target) return;
    const takeId = value.analysisFor;
    void (async () => {
      try {
        // Only the analysis modal opens here; recordings is still fetched because the analysis modal
        // itself lists sibling takes, not to also open the separate recordings modal on top of it.
        setRecordings(await pythonClient.listRecordings(target.id));
        // Right after a performance the analysis may not exist yet, so it is requested when there is no stored result.
        setAnalysis((await pythonClient.latestAnalysis(takeId)) ?? (await pythonClient.analyzeRecording(takeId)));
      } catch {
        notify(t("actionFailed"), "error");
      }
    })();
  }, [ready, songs, location.state, notify, t]);

  const analyze = (recording: RecordingDto) =>
    guarded(async () => setAnalysis(await pythonClient.analyzeRecording(recording.id)));

  const rename = (recording: RecordingDto, displayName: string) =>
    guarded(async () => {
      const saved = await pythonClient.renameRecording(recording.id, displayName);
      setRecordings(items => items.map(item => item.id === saved.id ? saved : item));
    });

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
    rename,
    remove,
    close: () => setSong(null),
    closeAnalysis: () => setAnalysis(null)
  };
};
