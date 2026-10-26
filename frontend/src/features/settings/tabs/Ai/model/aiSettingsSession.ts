import type {
  SettingsBackendPort,
  SettingsDesktopPort,
  SettingsJobEventsPort,
} from "../../../../../application/settings/SettingsPorts";
import type {
  AiProcessingSettingsDto,
  ModelDto,
  ProcessingJobDto,
} from "../../../../../contracts/models";

export type ProcessingBackend = AiProcessingSettingsDto["processingBackend"];
type Resource = "models" | "free" | "backend" | "dataRoot";
type Backend = Pick<
  SettingsBackendPort,
  | "listModels"
  | "freeStorageBytes"
  | "getAiProcessingSettings"
  | "updateAiProcessingSettings"
  | "downloadModel"
  | "deleteModel"
  | "getJob"
  | "cancelJob"
>;
type Desktop = Pick<
  SettingsDesktopPort,
  "getStorageRoot" | "pickStorageFolder" | "setStorageRoot"
>;
type ActiveJob = ProcessingJobDto & {
  state: "queued" | "processing" | "cancelling";
};

export const isJobActive = (
  job: ProcessingJobDto | undefined,
): job is ActiveJob =>
  job !== undefined &&
  ["queued", "processing", "cancelling"].includes(job.state);

interface AiSnapshot {
  models: readonly ModelDto[] | null;
  free: number | null;
  backend: ProcessingBackend;
  dataRoot: string;
  savingBackend: boolean;
  savingRoot: boolean;
  jobs: Readonly<Record<string, ProcessingJobDto>>;
  pendingDownloads: ReadonlySet<string>;
  errors: Partial<Record<Resource, unknown>>;
  downloadErrors: Readonly<Record<string, unknown>>;
}

/** Reads, writes and jobs share one owner; React never mirrors this state. */
export const createAiSettingsSession = (
  backend: Backend,
  desktop: Desktop,
  events: SettingsJobEventsPort,
) => {
  let snapshot: AiSnapshot = {
    models: null,
    free: null,
    backend: "Local",
    dataRoot: "",
    savingBackend: false,
    savingRoot: false,
    jobs: {},
    pendingDownloads: new Set(),
    errors: {},
    downloadErrors: {},
  };
  const listeners = new Set<() => void>();
  const running = new Map<string, Promise<ProcessingJobDto>>();
  const revision = { models: 0, free: 0, backend: 0, dataRoot: 0 };
  let modelRead: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleModelRefresh = () => {
    const needed =
      listeners.size > 0 &&
      !("models" in snapshot.errors) &&
      snapshot.models?.some(
        (model) =>
          model.state === "downloading" &&
          !isJobActive(snapshot.jobs[model.id]),
      );
    if (!needed) {
      clearTimeout(timer);
      timer = undefined;
    } else if (timer === undefined && !modelRead)
      timer = setTimeout(() => {
        timer = undefined;
        void readModels();
      }, 2000);
  };
  const publish = (patch: Partial<AiSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
    scheduleModelRefresh();
  };
  const withoutError = (key: Resource) => {
    const { [key]: _removed, ...errors } = snapshot.errors;
    return errors;
  };
  const read = async <K extends Resource>(
    key: K,
    load: () => Promise<AiSnapshot[K]>,
  ) => {
    const request = ++revision[key];
    try {
      const value = await load();
      if (revision[key] === request)
        publish({ [key]: value, errors: withoutError(key) });
    } catch (error) {
      if (revision[key] === request)
        publish({ errors: { ...snapshot.errors, [key]: error } });
    }
  };
  const readModels = () => {
    const pending = read("models", () => backend.listModels()).finally(() => {
      if (modelRead === pending) {
        modelRead = undefined;
        scheduleModelRefresh();
      }
    });
    modelRead = pending;
    return pending;
  };
  const refreshModels = () =>
    Promise.all([
      readModels(),
      read("free", () => backend.freeStorageBytes("models")),
    ]);
  const readBackend = () =>
    snapshot.savingBackend
      ? Promise.resolve()
      : read(
          "backend",
          async () =>
            (await backend.getAiProcessingSettings()).processingBackend,
        );
  const readRoot = () =>
    snapshot.savingRoot
      ? Promise.resolve()
      : read("dataRoot", () => desktop.getStorageRoot());

  const wait = async (jobId: string, milliseconds: number) => {
    try {
      await events.next(jobId, milliseconds);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  };
  const run = (modelId: string, start: () => Promise<ProcessingJobDto>) => {
    const existing = running.get(modelId);
    if (existing) return existing;
    const { [modelId]: _removed, ...downloadErrors } = snapshot.downloadErrors;
    publish({
      downloadErrors,
      pendingDownloads: new Set(snapshot.pendingDownloads).add(modelId),
    });
    const pending = Promise.resolve().then(async () => {
      try {
        let job = await start();
        const starting = new Set(snapshot.pendingDownloads);
        starting.delete(modelId);
        publish({
          jobs: { ...snapshot.jobs, [modelId]: job },
          pendingDownloads: starting,
        });
        let failures = 0;
        while (isJobActive(job)) {
          await wait(job.id, 700 * 2 ** failures);
          try {
            job = await backend.getJob(job.id);
            failures = 0;
            publish({ jobs: { ...snapshot.jobs, [modelId]: job } });
          } catch (error) {
            if (++failures >= 3) throw error;
          }
        }
        if (listeners.size) void refreshModels();
        return job;
      } catch (error) {
        publish({
          downloadErrors: { ...snapshot.downloadErrors, [modelId]: error },
        });
        throw error;
      } finally {
        running.delete(modelId);
        const starting = new Set(snapshot.pendingDownloads);
        starting.delete(modelId);
        publish({ pendingDownloads: starting });
      }
    });
    running.set(modelId, pending);
    return pending;
  };
  const resume = () => {
    publish({ downloadErrors: {} });
    for (const [modelId, job] of Object.entries(snapshot.jobs))
      if (isJobActive(job) && !running.has(modelId))
        void run(modelId, () => Promise.resolve(job)).catch(() => undefined);
  };
  const refresh = async () => {
    resume();
    await Promise.all([refreshModels(), readBackend(), readRoot()]);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => {
        listeners.delete(listener);
        scheduleModelRefresh();
      };
    },
    refresh,
    remove: async (model: ModelDto) => {
      if (running.has(model.id) || snapshot.pendingDownloads.has(model.id)) return;
      publish({ pendingDownloads: new Set(snapshot.pendingDownloads).add(model.id) });
      try {
        await backend.deleteModel(model);
        const { [model.id]: _removed, ...jobs } = snapshot.jobs;
        publish({ jobs });
        await refreshModels();
      } finally {
        const pendingDownloads = new Set(snapshot.pendingDownloads);
        pendingDownloads.delete(model.id);
        publish({ pendingDownloads });
      }
    },
    start: (model: ModelDto) =>
      run(model.id, () => {
        const job = snapshot.jobs[model.id];
        return isJobActive(job)
          ? Promise.resolve(job)
          : backend.downloadModel(model);
      }),
    cancel: async (jobId: string) => {
      await backend.cancelJob(jobId);
      resume();
    },
    changeBackend: async (next: ProcessingBackend) => {
      if (snapshot.savingBackend) return false;
      ++revision.backend;
      publish({ savingBackend: true });
      let saved = false;
      try {
        const result = await backend.updateAiProcessingSettings({
          processingBackend: next,
        });
        saved = true;
        publish({
          backend: result.processingBackend,
          errors: withoutError("backend"),
        });
        return true;
      } catch (error) {
        publish({ errors: { ...snapshot.errors, backend: error } });
        throw error;
      } finally {
        publish({ savingBackend: false });
        if (!saved) void readBackend();
      }
    },
    chooseDataRoot: async () => {
      if (snapshot.savingRoot) return;
      ++revision.dataRoot;
      publish({ savingRoot: true });
      let changed = false;
      try {
        const picked = await desktop.pickStorageFolder();
        if (!picked) return;
        await desktop.setStorageRoot(picked);
        changed = true;
        publish({ dataRoot: picked, errors: withoutError("dataRoot") });
      } catch (error) {
        publish({ errors: { ...snapshot.errors, dataRoot: error } });
        throw error;
      } finally {
        publish({ savingRoot: false });
        if (changed) {
          if (listeners.size) void refreshModels();
        } else void readRoot();
      }
    },
  };
};

const sessions = new WeakMap<
  Backend,
  ReturnType<typeof createAiSettingsSession>
>();
export const aiSettingsSessionFor = (
  backend: Backend,
  desktop: Desktop,
  events: SettingsJobEventsPort,
) => {
  let session = sessions.get(backend);
  if (!session) {
    session = createAiSettingsSession(backend, desktop, events);
    sessions.set(backend, session);
  }
  return session;
};
