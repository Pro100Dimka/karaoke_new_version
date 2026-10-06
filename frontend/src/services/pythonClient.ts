import type { PythonClient } from "../contracts/clients";
import type {
  AiProcessingSettingsDto,
  AppError,
  BackendDiagnosticsDto,
  EnvironmentSettingDto,
  ConfigurationValidationDto,
  KaggleActionDto,
  HistoryPageDto,
} from "../contracts/models";

import { nextJobChange } from "./backendEvents";
import { bridgedHttp } from "./desktopBridge";
import {
  jobProgress,
  mapAnalysis,
  mapJob,
  mapRecording,
  mapSong,
  modelState,
  numberAt,
  objectAt,
  optionalString,
  type BackendAnalysis,
  type BackendHistoryPage,
  type BackendJob,
  type BackendJobRef,
  type BackendModel,
  type BackendRecording,
  type BackendSong,
  type JobPage,
  type RecordingPage,
  type SongPage,
} from "./pythonMappers";

const request = <T>(
  method: PythonBridgeRequest["method"],
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> =>
  bridgedHttp<T>(
    "pythonRequest",
    { method, path, body, headers },
    "Python backend request failed",
  );

interface JobWait {
  /** Names the work in errors: "<label> failed", "<label> timed out". */
  label: string;
  /** How often the job is re-read when the backend cannot push its changes. */
  pollMilliseconds?: number;
  timeoutMilliseconds?: number;
  /** Cancels the job and rejects with an AbortError once aborted. */
  signal?: AbortSignal;
  onPoll?(job: BackendJob): void;
  failure?(job: BackendJob): unknown;
}

/** Follows a backend job until it succeeds; a failed, cancelled or interrupted job rejects. */
const waitForJob = async (
  jobId: string,
  wait: JobWait,
): Promise<BackendJob> => {
  const path = `/jobs/${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + (wait.timeoutMilliseconds ?? 300_000);
  const aborted = new Promise<void>((resolve) =>
    wait.signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
  while (Date.now() < deadline) {
    if (wait.signal?.aborted) {
      await request("POST", `${path}/cancel`);
      throw new DOMException(`${wait.label} cancelled`, "AbortError");
    }
    // Listening starts before the read, so a change landing during the read wakes the next one.
    const changed = nextJobChange(jobId, wait.pollMilliseconds ?? 250);
    const current = await request<BackendJob>("GET", path);
    wait.onPoll?.(current);
    if (current.state === "Succeeded") return current;
    if (["Failed", "Cancelled", "Interrupted"].includes(current.state))
      throw (
        wait.failure?.(current) ??
        new Error(`${wait.label} ${current.state.toLowerCase()}`)
      );
    await Promise.race([changed, aborted]);
  }
  throw new Error(`${wait.label} timed out`);
};

const waitForPackageReport = async (
  jobId: string,
): Promise<Record<string, unknown>> => {
  const job = await waitForJob(jobId, {
    label: "Package job",
    // The backend's own code (e.g. PackageConflict) lets the caller react to the reason.
    failure: (current) => {
      const error = current.error ?? {};
      return {
        code:
          typeof error.code === "string"
            ? error.code
            : `Package${current.state}`,
        message:
          typeof error.message === "string"
            ? error.message
            : `Package job ${current.state.toLowerCase()}`,
        details:
          error.details === undefined
            ? undefined
            : JSON.stringify(error.details),
        source: "python",
      } satisfies AppError;
    },
  });
  return job.report ?? {};
};

export const pythonClient: PythonClient = {
  async health() {
    const [health, version] = await Promise.all([
      request<{ ok: boolean; instanceId?: string }>("GET", "/health/ready"),
      request<{ backendVersion: string; apiVersion: number }>(
        "GET",
        "/version",
      ),
    ]);
    return {
      status: health.ok ? "ready" : "unavailable",
      version: version.backendVersion,
      apiVersion: version.apiVersion,
      instanceId: health.instanceId,
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

    const jobs = await request<JobPage>("GET", "/jobs?limit=200").catch(() => ({
      items: [],
      limit: 200,
      offset: 0,
    }));
    const activeJobs = new Map(
      jobs.items
        .filter((job) =>
          ["Queued", "Running", "Cancelling"].includes(job.state),
        )
        .map((job) => [job.entityId, job]),
    );
    return songs.map((value) => {
      const song = mapSong(value);
      const job = activeJobs.get(song.id);
      return job
        ? {
            ...song,
            jobId: job.jobId,
            stage: job.stage ?? undefined,
            progress: jobProgress(job),
          }
        : song;
    });
  },

  async getSong(songId) {
    return mapSong(
      await request<BackendSong>("GET", `/songs/${encodeURIComponent(songId)}`),
    );
  },

  async importSong(path, metadata, options) {
    const started = await request<BackendJob>(
      "POST",
      "/songs/imports",
      { sourcePath: path, title: metadata?.title, artist: metadata?.artist },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    options?.onProgress({
      jobId: started.jobId,
      stage: started.stage ?? "Queued",
      progress: 0,
    });
    const done = await waitForJob(started.jobId, {
      label: "Song import",
      signal: options?.signal,
      onPoll: (current) =>
        options?.onProgress({
          jobId: started.jobId,
          stage: current.stage ?? "Queued",
          progress: jobProgress(current),
        }),
    });
    const songId = done.report?.songId;
    if (typeof songId !== "string" || !songId)
      throw new Error("Song import completed without a song id");
    return mapSong(
      await request<BackendSong>("GET", `/songs/${encodeURIComponent(songId)}`),
    );
  },

  async exportProject(songId, revision) {
    const job = await request<BackendJobRef>(
      "POST",
      `/packages/export/${encodeURIComponent(songId)}?revision=${revision}`,
    );
    const report = await waitForPackageReport(job.jobId);
    if (typeof report.path !== "string" || !report.path)
      throw new Error("Package export completed without a path");
    return report.path;
  },

  async importProject(path, decision = "SafeOnly") {
    const job = await request<BackendJobRef>(
      "POST",
      "/packages/import",
      { path, decision },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    const report = await waitForPackageReport(job.jobId);
    if (typeof report.songId !== "string" || !report.songId)
      throw new Error("Package import completed without a song id");
    return mapSong(
      await request<BackendSong>(
        "GET",
        `/songs/${encodeURIComponent(report.songId)}`,
      ),
    );
  },

  async processSong(songId) {
    const job = await request<BackendJobRef>(
      "POST",
      `/songs/${encodeURIComponent(songId)}/processing`,
      { mode: "Auto", onlineLyrics: true },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    return mapJob(job, songId);
  },

  async cancelProcessing(jobId) {
    await request(
      "POST",
      `/songs/processing/${encodeURIComponent(jobId)}/cancel`,
    );
  },

  async updateSong(songId, patch) {
    return mapSong(
      await request<BackendSong>(
        "PATCH",
        `/songs/${encodeURIComponent(songId)}`,
        patch,
      ),
    );
  },

  async removeSongCover(songId) {
    return mapSong(
      await request<BackendSong>(
        "DELETE",
        `/songs/${encodeURIComponent(songId)}/cover`,
      ),
    );
  },

  async projectCompatibility(songId, revision) {
    const value = await request<{ compatibility: string }>(
      "GET",
      `/songs/${encodeURIComponent(songId)}/project/compatibility?revision=${revision}`,
    );
    const known = [
      "Current",
      "Upgradeable",
      "TooNew",
      "Unsupported",
      "Invalid",
    ] as const;
    return known.find((item) => item === value.compatibility) ?? "Invalid";
  },

  async deleteSong(songId) {
    await request("DELETE", `/songs/${encodeURIComponent(songId)}`);
  },

  async listRecordings(songId) {
    const page = await request<RecordingPage>(
      "GET",
      `/recordings?song_id=${encodeURIComponent(songId)}&limit=200`,
    );
    return page.items.map(mapRecording);
  },

  async analyzeRecording(recordingId) {
    const job = await request<BackendJobRef>(
      "POST",
      `/recordings/${encodeURIComponent(recordingId)}/analysis`,
    );
    await waitForJob(job.jobId, { label: "Analysis", pollMilliseconds: 500 });
    const analyses = await request<BackendAnalysis[]>(
      "GET",
      `/recordings/${encodeURIComponent(recordingId)}/analyses`,
    );
    const latest = analyses.at(-1);
    if (!latest) throw new Error("Analysis completed without a result");
    return mapAnalysis(latest);
  },

  async latestAnalysis(recordingId) {
    const analyses = await request<BackendAnalysis[]>(
      "GET",
      `/recordings/${encodeURIComponent(recordingId)}/analyses`,
    );
    const latest = analyses.filter((item) => item.state === "Succeeded").at(-1);
    return latest ? mapAnalysis(latest) : null;
  },

  async createStudioMaster(recordingId, onProgress) {
    const job = await request<BackendJobRef>(
      "POST",
      `/recordings/${encodeURIComponent(recordingId)}/studio-master`,
    );
    const done = await waitForJob(job.jobId, {
      label: "Studio mastering",
      pollMilliseconds: 500,
      timeoutMilliseconds: 600_000,
      onPoll: (current) =>
        onProgress?.({
          recordingId,
          stage: current.stage ?? "Queued",
          progress: jobProgress(current),
        }),
    });
    const masterId = done.report?.recordingId;
    if (typeof masterId !== "string" || !masterId)
      throw new Error("Studio mastering completed without a recording id");
    return mapRecording(
      await request<BackendRecording>(
        "GET",
        `/recordings/${encodeURIComponent(masterId)}`,
      ),
    );
  },

  async deleteRecording(recordingId) {
    await request("DELETE", `/recordings/${encodeURIComponent(recordingId)}`);
  },

  async renameRecording(recordingId, displayName) {
    return mapRecording(
      await request<BackendRecording>(
        "PATCH",
        `/recordings/${encodeURIComponent(recordingId)}`,
        { displayName },
      ),
    );
  },

  async listModels() {
    const models = await request<BackendModel[]>("GET", "/models");
    return models.map((model) => ({
      id: model.modelId,
      purpose: model.purpose,
      version: model.version,
      sizeBytes: model.size,
      state: modelState(model.state),
      selected: model.selected,
    }));
  },

  async getAiProcessingSettings(): Promise<AiProcessingSettingsDto> {
    return request<AiProcessingSettingsDto>("GET", "/settings");
  },

  async updateAiProcessingSettings(value): Promise<AiProcessingSettingsDto> {
    return request<AiProcessingSettingsDto>("PATCH", "/settings", value);
  },

  async listEnvironmentSettings(): Promise<readonly EnvironmentSettingDto[]> {
    return request<EnvironmentSettingDto[]>("GET", "/settings/environment");
  },

  async updateEnvironmentSetting(key, value): Promise<EnvironmentSettingDto> {
    return request<EnvironmentSettingDto>(
      "PATCH",
      `/settings/environment/${encodeURIComponent(key)}`,
      { value },
    );
  },

  async verifyEnvironmentSetting(key): Promise<EnvironmentSettingDto> {
    return request<EnvironmentSettingDto>(
      "POST",
      `/settings/environment/${encodeURIComponent(key)}/verify`,
    );
  },

  async verifyKaggleSettings(): Promise<ConfigurationValidationDto> {
    return request<ConfigurationValidationDto>(
      "POST",
      "/settings/kaggle/verify",
    );
  },

  async loginKaggle(): Promise<KaggleActionDto> {
    return request<KaggleActionDto>("POST", "/settings/kaggle/login");
  },

  async deployKaggle(): Promise<KaggleActionDto> {
    return request<KaggleActionDto>("POST", "/settings/kaggle/deploy");
  },

  async downloadModel(model) {
    const job = await request<BackendJobRef>(
      "POST",
      `/models/${encodeURIComponent(model.id)}/${encodeURIComponent(model.version)}/download`,
    );
    return mapJob(job);
  },

  async getJob(jobId) {
    return mapJob(
      await request<BackendJob>("GET", `/jobs/${encodeURIComponent(jobId)}`),
    );
  },

  async cancelJob(jobId) {
    await request("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`);
  },

  async listJobs() {
    const page = await request<JobPage>(
      "GET",
      "/jobs?limit=200&type=SongProcessing",
    );
    return page.items.map((job) => mapJob(job));
  },

  async diagnostics(): Promise<BackendDiagnosticsDto> {
    const [raw, version] = await Promise.all([
      request<unknown>("GET", "/diagnostics"),
      request<{ backendVersion: string; apiVersion: number }>(
        "GET",
        "/version",
      ),
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
      interruptedTransactions: numberAt(
        objectAt(raw, "recovery"),
        "interruptedTransactions",
      ),
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
        free: numberAt(usage, "free"),
      },
    };
  },

  async history(limit, offset): Promise<HistoryPageDto> {
    const page = await request<BackendHistoryPage>(
      "GET",
      `/history?limit=${limit}&offset=${offset}`,
    );
    return {
      total: page.total,
      items: page.items.map((item) => ({
        id: item.eventId,
        kind: item.eventType,
        createdAt: item.createdAt,
        songId: item.entityId ?? undefined,
        detail: item.details ? JSON.stringify(item.details) : undefined,
      })),
    };
  },

  async clearCache() {
    return (await request<{ removed: number }>("POST", "/storage/cache/clear"))
      .removed;
  },

  async clearTemporaryFiles() {
    return (await request<{ removed: number }>("POST", "/storage/temp/clear"))
      .removed;
  },
};
