import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAsk } from "../../app/DialogProvider";
import { useNotify } from "../../app/NotificationsProvider";
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from "../../contracts/models";
import type { StudioMasterProgress } from "../../contracts/clients";
import { useText } from "../../i18n/useText";
import { useLibraryCatalog } from "../../app/LibraryProvider";
import { useGuardedAction } from "./useGuardedAction";

/** Recordings and analysis for one song; also honours "open my take" navigation from a finished performance. */
export const useSongRecordings = (
  songs: readonly SongDto[],
  ready: boolean,
  onChanged: () => void,
) => {
  const location = useLocation();
  const ask = useAsk();
  const notify = useNotify();
  const t = useText();
  const guarded = useGuardedAction();
  const catalog = useLibraryCatalog();
  const [song, setSong] = useState<SongDto | null>(null);
  const [recordings, setRecordings] = useState<readonly RecordingDto[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const [studioMaster, setStudioMaster] = useState<StudioMasterProgress | null>(
    null,
  );
  // The take whose analysis was opened: songs finished on the TV open theirs one after another.
  const handled = useRef<string | null>(null);
  const requests = useRef({ recordings: 0, analysis: 0, master: 0 });

  const open = (target: SongDto) =>
    guarded(async () => {
      const request = ++requests.current.recordings;
      const items = await catalog.listRecordings(target.id);
      if (request !== requests.current.recordings) return;
      setRecordings(items);
      setSong(target);
    });

  useEffect(() => () => {
    handled.current = null;
    requests.current.recordings += 1;
    requests.current.analysis += 1;
    requests.current.master += 1;
  }, []);

  useEffect(() => {
    if (!ready) return;
    const state: unknown = location.state;
    const value =
      state && typeof state === "object"
        ? (state as Record<string, unknown>)
        : {};
    if (
      typeof value.analysisSongId !== "string" ||
      typeof value.analysisFor !== "string" ||
      handled.current === value.analysisFor
    )
      return;
    handled.current = value.analysisFor;
    const target = songs.find((item) => item.id === value.analysisSongId);
    if (!target) return;
    const takeId = value.analysisFor;
    const request = ++requests.current.analysis;
    const listRequest = ++requests.current.recordings;
    const current = () => request === requests.current.analysis &&
      listRequest === requests.current.recordings;
    void (async () => {
      try {
        // Only the analysis modal opens here; recordings is still fetched because the analysis modal
        // itself lists sibling takes, not to also open the separate recordings modal on top of it.
        const items = await catalog.listRecordings(target.id);
        if (!current()) return;
        setRecordings(items);
        // Right after a performance the analysis may not exist yet, so it is requested when there is no stored result.
        const stored = await catalog.latestAnalysis(takeId);
        if (!current()) return;
        const result = stored ?? await catalog.analyzeRecording(takeId);
        if (current()) setAnalysis(result);
      } catch {
        if (current()) notify(t("actionFailed"), "error");
      }
    })();
  }, [ready, songs, location.state, notify, t, catalog]);

  const analyze = (recording: RecordingDto) =>
    guarded(async () => {
      const request = ++requests.current.analysis;
      const result = await catalog.analyzeRecording(recording.id);
      if (request === requests.current.analysis) setAnalysis(result);
    });

  const rename = (recording: RecordingDto, displayName: string) =>
    guarded(async () => {
      const saved = await catalog.renameRecording(
        recording.id,
        displayName,
      );
      setRecordings((items) =>
        items.map((item) => (item.id === saved.id ? saved : item)),
      );
    });

  const remove = (recording: RecordingDto) =>
    guarded(async () => {
      const choice = await ask({
        title: t("deleteRecordingTitle"),
        body: t("deleteRecordingBody"),
        actions: [
          { id: "cancel", label: t("cancel") },
          { id: "delete", label: t("recordingDelete"), appearance: "primary" },
        ],
      });
      if (choice !== "delete") return;
      await catalog.deleteRecording(recording.id);
      setRecordings((items) =>
        items.filter((item) => item.id !== recording.id),
      );
      onChanged();
    });

  const createStudioMaster = (recording: RecordingDto) =>
    guarded(async () => {
      const listRequest = requests.current.recordings;
      const request = ++requests.current.master;
      setStudioMaster({
        recordingId: recording.id,
        stage: "Queued",
        progress: 0,
      });
      try {
        const mastered = await catalog.createStudioMaster(
          recording.id,
          (progress) => {
            if (request === requests.current.master) setStudioMaster(progress);
          },
        );
        if (listRequest === requests.current.recordings)
          setRecordings((items) => [
            mastered,
            ...items.filter((item) => item.id !== mastered.id),
          ]);
        notify(t("studioMasterReady"), "success");
      } finally {
        if (request === requests.current.master) setStudioMaster(null);
      }
    }, "studioMasterFailed");

  return {
    song,
    recordings,
    analysis,
    studioMaster,
    open,
    analyze,
    rename,
    remove,
    createStudioMaster,
    close: () => {
      requests.current.recordings += 1;
      setSong(null);
    },
    closeAnalysis: () => {
      requests.current.analysis += 1;
      setAnalysis(null);
    },
  };
};
