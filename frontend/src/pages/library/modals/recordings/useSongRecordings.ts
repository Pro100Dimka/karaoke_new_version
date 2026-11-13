import { tr, useLocale } from '@neo-ui-kit/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { refreshSongs } from '../../../../components/api-service';
import type {
  RecordingAnalysisProgress,
  StudioMasterProgress,
} from '../../../../contracts/clients';
import type {
  AnalysisDto,
  RecordingDto,
  SongDto,
} from '../../../../contracts/models';
import { ask } from '../../../../providers/dialog';
import { useNotify } from '../../../../providers/notifications';
import { store } from '../../../../providers/store';
import { audioClient as preview } from '../../../../services/audioClient';
import {
  backendPollInterval,
  nextRecordingChange,
  onRecordingsChange,
} from '../../../../services/backendEvents';
import { pythonClient as catalog } from '../../../../services/pythonClient';
import {
  clearOperationFailure,
  errorstring,
  observeOperation,
  reportOperationFailure,
  toAppError,
} from '../../../../shared/errors';
import { useGuardedAction } from '../../songs/useGuardedAction';

/** Recordings and analysis for one song; also honours "open my take" navigation from a finished performance. */
export const useSongRecordings = (
  requestedSong: SongDto | null,
  onRequestHandled: () => void,
  onAnalysisReady: (recordingId: string | null) => void,
) => {
  const client = useQueryClient();
  const returned = store.playback.returned;
  const notify = useNotify();
  const locale = useLocale();
  const guarded = useGuardedAction();
  const [song, setSong] = useState<SongDto | null>(null);
  const [recordings, setRecordings] = useState<readonly RecordingDto[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const [analysisSong, setAnalysisSong] = useState<SongDto | null>(null);
  const [analysisRecordId, setAnalysisRecordId] = useState<string | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<
    Readonly<Record<string, RecordingAnalysisProgress>>
  >({});
  const [analysisFailures, setAnalysisFailures] = useState<
    Readonly<Record<string, string>>
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
    const clearFailure = () =>
      setAnalysisFailures(({ [recordingId]: _, ...items }) => items);
    const listRequest = requests.current.recordings;
    let started = false;
    setAnalysisProgress((items) => ({
      ...items,
      [recordingId]: {
        recordingId,
        jobId: '',
        state: 'Queued',
        stage: 'Loading',
        progress: 0,
      },
    }));
    clearFailure();
    try {
      const stored = recalculate
        ? null
        : await catalog.latestAnalysis(recordingId);
      if (request !== requests.current.analysis) return null;
      if (stored) return stored;
      while (request === requests.current.analysis && ownsRun()) {
        const changed = nextRecordingChange(750);
        const items = await catalog.listRecordings(songId);
        if (request !== requests.current.analysis || !ownsRun()) return null;
        if (listRequest === requests.current.recordings) setRecordings(items);
        const current = items.find((item) => item.id === recordingId);
        if (current?.fileStatus === 'PreparationFailed') {
          setAnalysisFailures((items) => ({
            ...items,
            [recordingId]: 'recordingPreparationFailed',
          }));
        }
        if (
          !['Preparing', 'PreparationFailed'].includes(
            current?.fileStatus ?? '',
          )
        )
          break;
        setAnalysisProgress((items) => ({
          ...items,
          [recordingId]: {
            recordingId,
            jobId: '',
            state: 'Queued',
            stage: 'PreparingRecording',
            progress: 0,
          },
        }));
        await changed;
      }
      if (request !== requests.current.analysis || !ownsRun()) return null;
      clearFailure();
      started = true;
      return await catalog.analyzeRecording(recordingId, (progress) => {
        if (ownsRun())
          setAnalysisProgress((items) => ({
            ...items,
            [recordingId]: progress,
          }));
      });
    } catch (failure) {
      if (!ownsRun() || toAppError(failure).code === 'JobCancelled')
        return null;
      setAnalysisFailures((items) => ({
        ...items,
        [recordingId]: errorstring(toAppError(failure)) ?? 'actionFailed',
      }));
      throw failure;
    } finally {
      if (ownsRun())
        setAnalysisProgress(({ [recordingId]: _, ...items }) => items);
      if (started) {
        const items = await observeOperation(
          'errors.recordings',
          catalog.listRecordings(songId),
        ).catch(() => null);
        if (items && listRequest === requests.current.recordings)
          setRecordings(items);
      }
    }
  };

  const recordingsTargetId = song?.id ?? (analysisRecordId ? analysisSong?.id : undefined);
  const preparingRecordings = recordings.some((item) =>
    ['Preparing', 'PreparationFailed'].includes(item.fileStatus ?? ''),
  );
  useEffect(() => {
    if (!recordingsTargetId) return;
    let active = true;
    let pending = false;
    const request = requests.current.recordings;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void catalog
        .listRecordings(recordingsTargetId)
        .then((items) => {
          if (active && request === requests.current.recordings) {
            clearOperationFailure('errors.recordings');
            setRecordings(items);
          }
        })
        .catch((error: unknown) => {
          if (active && request === requests.current.recordings)
            reportOperationFailure('errors.recordings', error);
        })
        .finally(() => {
          pending = false;
        });
    };
    const stop = onRecordingsChange(refresh);
    const timer = preparingRecordings
      ? window.setInterval(refresh, backendPollInterval(1000))
      : undefined;
    return () => {
      active = false;
      stop();
      window.clearInterval(timer);
    };
  }, [recordingsTargetId, preparingRecordings]);

  const open = (target: SongDto) =>
    guarded(async () => {
      const request = ++requests.current.recordings;
      // Show the dialog immediately; the network must not delay its first paint.
      setSong(target);
      setRecordings([]);
      setLoadingRecordings(true);
      try {
        const items = await catalog.listRecordings(target.id);
        if (request === requests.current.recordings) setRecordings(items);
      } finally {
        if (request === requests.current.recordings) setLoadingRecordings(false);
      }
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
    const value = returned;
    if (
      !value?.analysisSongId ||
      !value.analysisFor ||
      handled.current === value.analysisFor
    )
      return;
    handled.current = value.analysisFor;
    const takeId = value.analysisFor;
    const songId = value.analysisSongId;
    const request = ++requests.current.analysis;
    const listRequest = ++requests.current.recordings;
    const current = () =>
      request === requests.current.analysis &&
      listRequest === requests.current.recordings;
    setAnalysis(null);
    setAnalysisSong(null);
    setAnalysisRecordId(takeId);
    void (async () => {
      try {
        const target = await client.fetchQuery({
          queryKey: ['song', store.application.services.pythonEpoch, songId],
          queryFn: () => catalog.getSong(songId),
          staleTime: 0,
        });
        if (!current()) return;
        setAnalysisSong(target);
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
            tr(errorstring(toAppError(failure)) ?? 'actionFailed'),
            'error',
          );
      }
    })();
  }, [returned, notify, locale, client]);

  const analyze = (recording: RecordingDto, recalculate = false) =>
    guarded(async () => {
      const request = ++requests.current.analysis;
      setAnalysis(null);
      setAnalysisSong(
        [song, analysisSong].find((item) => item?.id === recording.songId) ??
          null,
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
        title: tr('deleteRecordingTitle'),
        body: tr('deleteRecordingBody'),
        actions: [
          { id: 'cancel', label: tr('cancel') },
          {
            id: 'delete',
            label: tr('recordingDelete'),
            appearance: 'primary',
          },
        ],
      });
      if (choice !== 'delete') return;
      await preview.stopRecordingPreview(undefined, recording.id);
      await catalog.deleteRecording(recording.id);
      setRecordings((items) =>
        items.filter((item) => item.id !== recording.id),
      );
      void refreshSongs(client);
    });

  const createStudioMaster = (recording: RecordingDto) =>
    guarded(async () => {
      const listRequest = requests.current.recordings;
      const request = ++requests.current.master;
      setStudioMaster({
        recordingId: recording.id,
        stage: 'Queued',
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
        notify(tr('studioMasterReady'), 'success');
      } finally {
        if (request === requests.current.master) setStudioMaster(null);
      }
    }, 'studioMasterFailed');

  useEffect(() => {
    onAnalysisReady(analysisRecordId);
  }, [analysisRecordId, onAnalysisReady]);
  const openLatest = useRef(open);
  useEffect(() => {
    openLatest.current = open;
  });
  useEffect(() => {
    if (!requestedSong) return;
    onRequestHandled();
    void openLatest.current(requestedSong);
  }, [requestedSong, onRequestHandled]);

  return {
    song,
    recordings,
    loadingRecordings,
    analysis,
    analysisSong,
    analysisRecordId,
    analysisProgress,
    analysisFailures,
    cancelAnalysis: (jobId: string) => guarded(() => catalog.cancelJob(jobId)),
    studioMaster,
    analyze,
    rename,
    remove,
    createStudioMaster,
    close: () => {
      requests.current.recordings += 1;
      setLoadingRecordings(false);
      setSong(null);
    },
    closeAnalysis: () => {
      requests.current.analysis += 1;
      setAnalysis(null);
      setAnalysisRecordId(null);
    },
  };
};
