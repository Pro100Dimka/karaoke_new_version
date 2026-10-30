import { reaction, runInAction } from "mobx";
import { tr, useLocale } from "@neo-ui-kit/react";
import { pythonClient as catalog } from "../../../services/pythonClient";
import { useEffect, useRef, useState } from "react";
import { store } from "../../../providers/store";
import { ask } from "../../../providers/dialog";
import { useNotify } from "../../../providers/notifications";
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from "../../../contracts/models";
import type {
  RecordingAnalysisProgress,
  StudioMasterProgress,
} from "../../../contracts/clients";
import { ru } from "../../../i18n/messages.ru";
import type { MessageKey } from "../../../i18n/messages";
import { useGuardedAction } from "./useGuardedAction";
import { errorMessageKey, toAppError } from "../../../shared/errors";

/** Recordings and analysis for one song; also honours "open my take" navigation from a finished performance. */
export const useSongRecordings = (
  songs: readonly SongDto[],
  ready: boolean,
  onChanged: () => void,
) => {
  const returned = store.playback.returned;
  const notify = useNotify();
  const locale = useLocale();
  const guarded = useGuardedAction();
  const [song, setSong] = useState<SongDto | null>(null);
  const [recordings, setRecordings] = useState<readonly RecordingDto[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const [analysisSong, setAnalysisSong] = useState<SongDto | null>(null);
  const [analysisRecordId, setAnalysisRecordId] = useState<string | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<
    Readonly<Record<string, RecordingAnalysisProgress>>
  >({});
  const [analysisFailures, setAnalysisFailures] = useState<
    Readonly<Record<string, MessageKey>>
  >({});
  const [studioMaster, setStudioMaster] = useState<StudioMasterProgress | null>(
    null,
  );
  // The take whose analysis was opened: songs finished on the TV open theirs one after another.
  const handled = useRef<string | null>(null);
  const requests = useRef({ recordings: 0, analysis: 0, master: 0 });
  const analysisRuns = useRef(new Map<string, number>());

  const loadAnalysis = async (
    recordingId: string,
    songId: string,
    recalculate: boolean,
    request: number,
  ) => {
    analysisRuns.current.set(recordingId, request);
    const ownsRun = () => analysisRuns.current.get(recordingId) === request;
    const listRequest = requests.current.recordings;
    let started = false;
    setAnalysisProgress((items) => ({
      ...items,
      [recordingId]: {
        recordingId,
        jobId: "",
        state: "Queued",
        stage: "Loading",
        progress: 0,
      },
    }));
    setAnalysisFailures((items) =>
      Object.fromEntries(
        Object.entries(items).filter(([id]) => id !== recordingId),
      ),
    );
    try {
      const stored = recalculate
        ? null
        : await catalog.latestAnalysis(recordingId);
      if (request !== requests.current.analysis) return null;
      if (stored) return stored;
      while (request === requests.current.analysis && ownsRun()) {
        const items = await catalog.listRecordings(songId);
        if (request !== requests.current.analysis || !ownsRun()) return null;
        if (listRequest === requests.current.recordings) setRecordings(items);
        const current = items.find((item) => item.id === recordingId);
        if (current?.fileStatus === "PreparationFailed") {
          setAnalysisFailures((items) => ({ ...items, [recordingId]: "recordingPreparationFailed" }));
        }
        if (!["Preparing", "PreparationFailed"].includes(current?.fileStatus ?? "")) break;
        setAnalysisProgress((items) => ({ ...items, [recordingId]: {
          recordingId, jobId: "", state: "Queued", stage: "PreparingRecording", progress: 0,
        } }));
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      if (request !== requests.current.analysis || !ownsRun()) return null;
      setAnalysisFailures((items) => Object.fromEntries(Object.entries(items).filter(([id]) => id !== recordingId)));
      started = true;
      return await catalog.analyzeRecording(recordingId, (progress) => {
        if (ownsRun())
          setAnalysisProgress((items) => ({
            ...items,
            [recordingId]: progress,
          }));
      });
    } catch (failure) {
      if (!ownsRun() || toAppError(failure).code === "JobCancelled")
        return null;
      setAnalysisFailures((items) => ({
        ...items,
        [recordingId]: errorMessageKey(toAppError(failure)) ?? "actionFailed",
      }));
      throw failure;
    } finally {
      if (ownsRun())
        setAnalysisProgress((items) =>
          Object.fromEntries(
            Object.entries(items).filter(([id]) => id !== recordingId),
          ),
        );
      if (started) {
        const items = await catalog.listRecordings(songId).catch(() => null);
        if (items && listRequest === requests.current.recordings)
          setRecordings(items);
      }
    }
  };

  useEffect(() => {
    const target = song ?? (analysisRecordId ? analysisSong : null);
    if (!target || !recordings.some((item) => ["Preparing", "PreparationFailed"].includes(item.fileStatus ?? ""))) return;
    let active = true;
    const request = requests.current.recordings;
    const timer = window.setTimeout(() => {
      void catalog.listRecordings(target.id).then((items) => {
        if (active && request === requests.current.recordings) setRecordings(items);
      }).catch(() => undefined);
    }, 1000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [song, analysisSong, analysisRecordId, recordings]);

  const open = (target: SongDto) =>
    guarded(async () => {
      const request = ++requests.current.recordings;
      const items = await catalog.listRecordings(target.id);
      if (request !== requests.current.recordings) return;
      setRecordings(items);
      setSong(target);
    });

  useEffect(
    () => () => {
      analysisRuns.current.clear();
      handled.current = null;
      requests.current.recordings += 1;
      requests.current.analysis += 1;
      requests.current.master += 1;
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    const value = returned;
    if (!value?.analysisSongId || !value.analysisFor || handled.current === value.analysisFor) return;
    const target = songs.find((item) => item.id === value.analysisSongId);
    if (!target) return;
    handled.current = value.analysisFor;
    const takeId = value.analysisFor;
    const request = ++requests.current.analysis;
    const listRequest = ++requests.current.recordings;
    const current = () =>
      request === requests.current.analysis &&
      listRequest === requests.current.recordings;
    setAnalysisSong(target);
    setAnalysisRecordId(takeId);
    void (async () => {
      try {
        // Only the analysis modal opens here; recordings is still fetched because the analysis modal
        // itself lists sibling takes, not to also open the separate recordings modal on top of it.
        const items = await catalog.listRecordings(target.id);
        if (!current()) return;
        setRecordings(items);
        // Right after a performance the analysis may not exist yet, so it is requested when there is no stored result.
        const result = await loadAnalysis(takeId, target.id, false, request);
        if (current()) setAnalysis(result);
      } catch (failure) {
        if (current())
          notify(
            tr(ru[errorMessageKey(toAppError(failure)) ?? "actionFailed"]),
            "error",
          );
      }
    })();
  }, [ready, songs, returned, notify, locale, catalog]);

  const analyze = (recording: RecordingDto, recalculate = false) =>
    guarded(async () => {
      const request = ++requests.current.analysis;
      setAnalysis(null);
      setAnalysisSong(
        songs.find((item) => item.id === recording.songId) ?? null,
      );
      setAnalysisRecordId(recording.id);
      const result = await loadAnalysis(
        recording.id,
        recording.songId,
        recalculate,
        request,
      );
      if (request === requests.current.analysis) setAnalysis(result);
    });

  const rename = (recording: RecordingDto, displayName: string) =>
    guarded(async () => {
      const saved = await catalog.renameRecording(recording.id, displayName);
      setRecordings((items) =>
        items.map((item) => (item.id === saved.id ? saved : item)),
      );
    });

  const remove = (recording: RecordingDto) =>
    guarded(async () => {
      const choice = await ask({
        title: tr(ru.deleteRecordingTitle),
        body: tr(ru.deleteRecordingBody),
        actions: [
          { id: "cancel", label: tr(ru.cancel) },
          { id: "delete", label: tr(ru.recordingDelete), appearance: "primary" },
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
        notify(tr(ru.studioMasterReady), "success");
      } finally {
        if (request === requests.current.master) setStudioMaster(null);
      }
    }, "studioMasterFailed");

  useEffect(() => {
    runInAction(() => { store.libraryDialogs.analysisRecordId = analysisRecordId; });
    return () => runInAction(() => { store.libraryDialogs.analysisRecordId = null; });
  }, [analysisRecordId]);
  const openLatest = useRef(open);
  useEffect(() => { openLatest.current = open; });
  useEffect(() => reaction(() => store.libraryDialogs.recordingsSong, requested => {
    if (!requested) return;
    runInAction(() => { store.libraryDialogs.recordingsSong = null; });
    void openLatest.current(requested);
  }, { fireImmediately: true }), []);

  return {
    song,
    recordings,
    analysis,
    analysisSong,
    analysisRecordId,
    analysisProgress,
    analysisFailures,
    cancelAnalysis: (jobId: string) => guarded(() => catalog.cancelJob(jobId)),
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
      setAnalysisRecordId(null);
    },
  };
};
