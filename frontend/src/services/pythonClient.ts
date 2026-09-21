import type { PythonClient } from "../contracts/clients";
import type {
  AnalysisDto,
  AppError,
  BackendDiagnosticsDto,
  HistoryPageDto,
  ModelDto,
  ParticipantDto,
  ProcessingJobDto,
  RecordingDto,
  RoomStateDto,
  SongDto,
  SongStatus
} from "../contracts/models";

import { BackendSong, SongPage, BackendJobRef, BackendJob, JobPage, RecordingPage, BackendAnalysis, BackendRoom, mapSong, mapJob, mapRecording, mapAnalysis, participantId, mapRoom, BackendModel, BackendHistoryPage, modelState, numberAt, objectAt, optionalString } from "./pythonMappers";

const bridge = (): DesktopApi => {
  if (!window.desktop) throw new Error("Desktop bridge is unavailable");
  return window.desktop;
};

const request = async <T>(
  method: PythonBridgeRequest["method"],
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<T> => {
  const response = await bridge().pythonRequest({ method, path, body, headers });
  if (!response.ok) {
    const raw = response.body && typeof response.body === "object"
      ? response.body as Record<string, unknown>
      : {};
    const error: AppError = {
      code: typeof raw.code === "string" ? raw.code : `Http${response.status}`,
      message: typeof raw.message === "string" ? raw.message : "Python backend request failed",
      details: raw.details === undefined ? undefined : JSON.stringify(raw.details),
      source: "python",
      correlationId: typeof raw.requestId === "string" ? raw.requestId : undefined
    };
    throw error;
  }
  return response.body as T;
};

const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

export const pythonClient: PythonClient = {
  async health() {
    const [health, version] = await Promise.all([
      request<{ ok: boolean }>("GET", "/health/ready"),
      request<{ backendVersion: string; apiVersion: number }>("GET", "/version")
    ]);
    return {
      status: health.ok ? "ready" : "unavailable",
      version: version.backendVersion,
      apiVersion: version.apiVersion
    };
  },

  async listSongs() {
    const songs: BackendSong[] = [];
    let cursor: string | null = null;
    do {
      const requestPath: string = `/songs?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: SongPage = await request<SongPage>("GET", requestPath);
      songs.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    const jobs = await request<JobPage>("GET", "/jobs?limit=200").catch(() => ({ items: [], limit: 200, offset: 0 }));
    const activeJobs = new Map(jobs.items.filter(job => ["Queued", "Running", "Cancelling"].includes(job.state)).map(job => [job.entityId, job]));
    return songs.map(value => {
      const song = mapSong(value);
      const job = activeJobs.get(song.id);
      return job
        ? {
            ...song,
            jobId: job.jobId,
            stage: job.stage ?? undefined,
            progress: Math.round(job.overallProgress * (job.overallProgress <= 1 ? 100 : 1))
          }
        : song;
    });
  },

  async getSong(songId) {
    return mapSong(await request<BackendSong>("GET", `/songs/${encodeURIComponent(songId)}`));
  },

  async importSong(path, metadata) {
    return mapSong(await request<BackendSong>("POST", "/songs", { sourcePath: path, title: metadata?.title, artist: metadata?.artist }, { "Idempotency-Key": crypto.randomUUID() }));
  },

  async processSong(songId) {
    const job = await request<BackendJobRef>("POST", `/songs/${encodeURIComponent(songId)}/processing`, { mode: "Auto", onlineLyrics: true }, { "Idempotency-Key": crypto.randomUUID() });
    return mapJob(job, songId);
  },

  async cancelProcessing(jobId) {
    await request("POST", `/songs/processing/${encodeURIComponent(jobId)}/cancel`);
  },

  async updateSong(songId, patch) {
    return mapSong(await request<BackendSong>("PATCH", `/songs/${encodeURIComponent(songId)}`, patch));
  },

  async projectCompatibility(songId, revision) {
    const value = await request<{ compatibility: string }>(
      "GET",
      `/songs/${encodeURIComponent(songId)}/project/compatibility?revision=${revision}`
    );
    const known = ["Current", "Upgradeable", "TooNew", "Unsupported", "Invalid"] as const;
    return known.find(item => item === value.compatibility) ?? "Invalid";
  },

  async deleteSong(songId) {
    await request("DELETE", `/songs/${encodeURIComponent(songId)}`);
  },

  async listRecordings(songId) {
    const page = await request<RecordingPage>("GET", `/recordings?song_id=${encodeURIComponent(songId)}&limit=200`);
    return page.items.map(mapRecording);
  },

  async analyzeRecording(recordingId) {
    const job = await request<BackendJobRef>("POST", `/recordings/${encodeURIComponent(recordingId)}/analysis`);
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const current = await request<BackendJob>("GET", `/jobs/${encodeURIComponent(job.jobId)}`);
      if (current.state === "Succeeded") {
        const analyses = await request<BackendAnalysis[]>("GET", `/recordings/${encodeURIComponent(recordingId)}/analyses`);
        const latest = analyses.at(-1);
        if (!latest) throw new Error("Analysis completed without a result");
        return mapAnalysis(latest);
      }
      if (["Failed", "Cancelled", "Interrupted"].includes(current.state)) {
        throw new Error(`Analysis ${current.state.toLowerCase()}`);
      }
      await wait(500);
    }
    throw new Error("Analysis timed out");
  },

  async latestAnalysis(recordingId) {
    const analyses = await request<BackendAnalysis[]>("GET", `/recordings/${encodeURIComponent(recordingId)}/analyses`);
    const latest = analyses.filter(item => item.state === "Succeeded").at(-1);
    return latest ? mapAnalysis(latest) : null;
  },

  async deleteRecording(recordingId) {
    await request("DELETE", `/recordings/${encodeURIComponent(recordingId)}`);
  },

  async createRoom(displayName) {
    const room = await request<BackendRoom>("POST", "/rooms", {
      participantId,
      displayName,
      disconnectPolicy: "Transfer"
    });
    return mapRoom(room);
  },

  async joinRoom(code, displayName) {
    const room = await request<BackendRoom>("POST", `/rooms/${encodeURIComponent(code)}/join`, {
      participantId,
      displayName
    });
    return mapRoom(room);
  },

  async getRoom(code) {
    return mapRoom(await request<BackendRoom>("GET", `/rooms/${encodeURIComponent(code)}`));
  },

  async leaveRoom(code) {
    await request("POST", `/rooms/${encodeURIComponent(code)}/leave`, { participantId });
  },

  async selectRoomSong(code, songId, revision) {
    return mapRoom(
      await request<BackendRoom>("POST", `/rooms/${encodeURIComponent(code)}/song`, { participantId, songId, revision })
    );
  },

  async setRoomReadiness(code, readiness) {
    return mapRoom(
      await request<BackendRoom>("POST", `/rooms/${encodeURIComponent(code)}/readiness`, { participantId, readiness })
    );
  },

  async roomControl(code, command) {
    await request("POST", `/rooms/${encodeURIComponent(code)}/control`, { participantId, command });
  },

  async listModels() {
    const models = await request<BackendModel[]>("GET", "/models");
    return models.map(model => ({
      id: model.modelId,
      purpose: model.purpose,
      version: model.version,
      sizeBytes: model.size,
      state: modelState(model.state),
      selected: model.selected
    }));
  },

  async downloadModel(model) {
    const job = await request<BackendJobRef>(
      "POST",
      `/models/${encodeURIComponent(model.id)}/${encodeURIComponent(model.version)}/download`
    );
    return mapJob(job);
  },

  async getJob(jobId) {
    return mapJob(await request<BackendJob>("GET", `/jobs/${encodeURIComponent(jobId)}`));
  },

  async cancelJob(jobId) {
    await request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`);
  },

  async listJobs() {
    const page = await request<JobPage>("GET", "/jobs?limit=200&type=SongProcessing");
    return page.items.map(job => mapJob(job));
  },

  async diagnostics(): Promise<BackendDiagnosticsDto> {
    const [raw, version] = await Promise.all([
      request<unknown>("GET", "/diagnostics"),
      request<{ backendVersion: string; apiVersion: number }>("GET", "/version")
    ]);
    const backend = objectAt(raw, "backend");
    const ai = objectAt(raw, "ai");
    const versions = objectAt(raw, "versions");
    const usage = objectAt(objectAt(raw, "storage"), "usage");
    return {
      state: optionalString(backend.state) ?? "Unknown",
      database: backend.database === true,
      cudaAvailable: ai.cuda_available === true,
      gpuName: optionalString(ai.gpu_name),
      ffmpegVersion: optionalString(ai.ffmpeg_version),
      pytorchVersion: optionalString(ai.pytorch_version),
      interruptedTransactions: numberAt(objectAt(raw, "recovery"), "interruptedTransactions"),
      backendVersion: version.backendVersion,
      apiVersion: version.apiVersion,
      dbSchema: numberAt(versions, "dbSchema"),
      projectFormat: numberAt(versions, "projectFormat"),
      storage: {
        songs: numberAt(usage, "songs"),
        models: numberAt(usage, "models"),
        cache: numberAt(usage, "cache"),
        recordings: numberAt(usage, "recordings"),
        temp: numberAt(usage, "temp"),
        free: numberAt(usage, "free")
      }
    };
  },

  async history(limit, offset): Promise<HistoryPageDto> {
    const page = await request<BackendHistoryPage>("GET", `/history?limit=${limit}&offset=${offset}`);
    return {
      total: page.total,
      items: page.items.map(item => ({
        id: item.eventId,
        kind: item.eventType,
        createdAt: item.createdAt,
        songId: item.entityId ?? undefined,
        detail: item.details ? JSON.stringify(item.details) : undefined
      }))
    };
  },

  async clearCache() {
    return (await request<{ removed: number }>("POST", "/storage/cache/clear")).removed;
  },

  async clearTemporaryFiles() {
    return (await request<{ removed: number }>("POST", "/storage/temp/clear")).removed;
  }
};

export const pythonBridgeRequest = request;
