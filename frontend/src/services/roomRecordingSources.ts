import type { RoomPerformanceSummary } from '../contracts/models';
import type { BackendRecording } from './pythonMappers';
import { recordingsChanged } from './backendEvents';
import { bridgedHttp, desktopBridge } from './desktopBridge';
import { participantId } from './roomMappers';
import { toAppError } from '../shared/errors';

const collecting = new Map<string, Promise<void>>();
const sourcePath = (
  performance: Pick<RoomPerformanceSummary, 'roomId' | 'performanceId'>,
) =>
  `/rooms/${encodeURIComponent(performance.roomId)}/performances/${performance.performanceId}/sources`;

export const beginRoomRecordingSource = async (
  performance: Pick<RoomPerformanceSummary, 'roomId' | 'performanceId'>,
  captureId: string,
): Promise<void> => {
  await bridgedHttp(
    'roomRequest',
    {
      method: 'POST',
      path: `${sourcePath(performance)}/${encodeURIComponent(participantId)}/captures/${encodeURIComponent(captureId)}`,
      headers: { 'X-Participant-Id': participantId },
    },
    'Could not register the room microphone capture',
  );
};

export const markSilentRoomSource = async (
  performance: RoomPerformanceSummary,
  captureId?: string,
): Promise<void> => {
  if (typeof desktopBridge().roomRequest !== 'function') return;
  await bridgedHttp(
    'roomRequest',
    {
      method: 'PUT',
      path: `${sourcePath(performance)}/${encodeURIComponent(participantId)}${captureId ? `/captures/${encodeURIComponent(captureId)}` : ''}`,
      headers: { 'X-Participant-Id': participantId },
    },
    'Could not publish the silent room source',
  );
};

const collectSources = async (recordingId: string): Promise<void> => {
  const desktop = desktopBridge();
  if (typeof desktop.uploadRoomSource !== 'function') return;
  const base = `/recordings/${encodeURIComponent(recordingId)}`;
  const recording = await bridgedHttp<BackendRecording>(
    'pythonRequest',
    { method: 'GET', path: base },
    'Recording is unavailable',
  );
  const performance = recording.roomPerformance;
  if (
    !performance ||
    !recording.roomSources ||
    recording.roomSources.status === 'ready'
  )
    return;
  const sourceRequest = {
    roomId: performance.roomId,
    performanceId: performance.performanceId,
    participantId,
  };
  const sources: Record<string, string[] | null> = {};
  const importedCaptures = new Set<string>();
  try {
    const exported = await bridgedHttp<{ filePath: string }>(
      'pythonRequest',
      {
        method: 'POST',
        path: `${base}/room-source`,
        body: { participantId },
      },
      'The separate singer source is unavailable',
    );
    await desktop.uploadRoomSource({
      ...sourceRequest,
      captureId: recordingId,
      path: exported.filePath,
      transferId: `${recordingId}:source-upload`,
    });
    const own = await bridgedHttp<{ directory: string }>(
      'pythonRequest',
      {
        method: 'POST',
        path: `${base}/room-source/import`,
        body: { participantId, filePath: exported.filePath },
      },
      'Could not prepare the local singer source',
    );
    sources[participantId] = [own.directory];
    importedCaptures.add(`${participantId}:${recordingId}`);
    let lastProgress = '',
      movedAt = Date.now();
    for (;;) {
      const manifest = await bridgedHttp<{
        complete: boolean;
        participants: {
          participantId: string;
          available: boolean;
          sizeBytes: number;
          uploadBytes?: number;
          captures?: {
            captureId: string;
            available: boolean;
            sizeBytes: number;
            uploadBytes?: number;
          }[];
        }[];
      }>(
        'roomRequest',
        {
          method: 'GET',
          path: sourcePath(performance),
          headers: { 'X-Participant-Id': participantId },
        },
        'Room singer sources are unavailable',
      );
      const progress = JSON.stringify(manifest.participants);
      if (progress !== lastProgress) {
        movedAt = Date.now();
        lastProgress = progress;
      }
      for (const singer of manifest.participants) {
        if (!singer.available) continue;
        if (singer.sizeBytes === 0) {
          sources[singer.participantId] = null;
          for (const capture of singer.captures ?? [])
            importedCaptures.add(
              `${singer.participantId}:${capture.captureId}`,
            );
          continue;
        }
        for (const capture of singer.captures ?? []) {
          const key = `${singer.participantId}:${capture.captureId}`;
          if (!capture.available || importedCaptures.has(key)) continue;
          if (!capture.sizeBytes) {
            importedCaptures.add(key);
            sources[singer.participantId] ??= [];
            continue;
          }
          const file = await desktop.downloadRoomSource({
            ...sourceRequest,
            sourceParticipantId: singer.participantId,
            captureId: capture.captureId,
            transferId: `${recordingId}:source:${singer.participantId}:${capture.captureId}`,
          });
          try {
            const imported = await bridgedHttp<{ directory: string }>(
              'pythonRequest',
              {
                method: 'POST',
                path: `${base}/room-source/import`,
                body: { participantId: singer.participantId, filePath: file },
              },
              'Could not prepare the remote singer source',
            );
            (sources[singer.participantId] ??= []).push(imported.directory);
            importedCaptures.add(key);
          } finally {
            await desktop.releaseRoomProjectDownload(file);
          }
          movedAt = Date.now();
        }
      }
      if (
        manifest.complete &&
        manifest.participants.length &&
        manifest.participants.every(
          (singer) =>
            singer.available &&
            Object.hasOwn(sources, singer.participantId) &&
            (singer.captures ?? []).every((capture) =>
              importedCaptures.has(
                `${singer.participantId}:${capture.captureId}`,
              ),
            ),
        )
      )
        break;
      // Match file transfers: a slow source may continue while its upload is making progress.
      if (Date.now() - movedAt >= 60_000)
        throw new Error('Room singer source transfer stalled');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await bridgedHttp(
      'pythonRequest',
      {
        method: 'POST',
        path: `${base}/room-sources`,
        body: { participants: sources },
      },
      'Could not publish the room sources',
    );
  } catch (error) {
    await bridgedHttp(
      'pythonRequest',
      {
        method: 'POST',
        path: `${base}/room-sources`,
        body: {
          participants: sources,
          failure: toAppError(error).message,
        },
      },
      'Could not save room source status',
    ).catch(() => undefined);
    throw error;
  } finally {
    recordingsChanged();
  }
};

export const prepareRoomRecordingSources = (
  recordingId: string,
): Promise<void> => {
  const active = collecting.get(recordingId);
  if (active) return active;
  const request = collectSources(recordingId).finally(() =>
    collecting.delete(recordingId),
  );
  collecting.set(recordingId, request);
  return request;
};
