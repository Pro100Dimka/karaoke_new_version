import type { SettingsBackendPort } from "../../../../../application/settings/SettingsPorts";
import {
  kaggleDeployment,
  kaggleDeploymentRunning,
} from "../../../../../application/settings/KaggleDeployment";
import type { EnvironmentSettingDto } from "../../../../../contracts/models";
import {
  isSecret,
  saveDelayMilliseconds,
  type DisplayEntry,
  type DisplayState,
} from "./environmentModel";

type Field = {
  confirmed: EnvironmentSettingDto;
  draft?: string;
  revision: number;
  state?: DisplayState;
  error?: unknown;
  debounce?: ReturnType<typeof setTimeout>;
  write?: Promise<EnvironmentSettingDto | null>;
};
type KaggleAction = "login" | "deploy";
type KaggleRun = {
  phase: KaggleAction;
  startedAt: number | null;
  promise: Promise<string>;
};
type Check = ReadonlyMap<Field, number>;
export type EnvironmentSnapshot = {
  entries: DisplayEntry[] | null;
  loadError: unknown;
  kaggleAction: KaggleAction | null;
  kaggleStartedAt: number | null;
};

const verifiesAlone = (key: string) => key !== "KAGGLE_API_TOKEN";
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : null;
const confirmedEntry = (entry: EnvironmentSettingDto): EnvironmentSettingDto =>
  isSecret(entry) ? { ...entry, value: "" } : entry;

/** One backend-scoped session. Each field owns its confirmed value, draft and pending write. */
export class EnvironmentStore {
  private fields = new Map<string, Field>();
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private readRevision = 0;
  private action: KaggleRun | null = null;
  private loaded = false;
  private snapshot: EnvironmentSnapshot = {
    entries: null,
    loadError: null,
    kaggleAction: null,
    kaggleStartedAt: null,
  };

  constructor(private readonly backend: SettingsBackendPort) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(change: { loadError?: unknown } = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...change,
      entries: this.loaded
        ? Array.from(
            this.fields.values(),
            ({ confirmed, draft, state, error }) => ({
              ...confirmed,
              value: draft ?? confirmed.value,
              state: state ?? confirmed.state,
              ...(error !== undefined && { errorMessage: errorMessage(error) }),
            }),
          )
        : null,
      kaggleAction: this.action?.phase ?? null,
      kaggleStartedAt: this.action?.startedAt ?? null,
    };
    this.listeners.forEach((listener) => listener());
  }

  private async readEntries(revision = ++this.readRevision) {
    const revisions = new Map(
      Array.from(this.fields.values(), (field) => [field, field.revision]),
    );
    const entries = await this.backend.listEnvironmentSettings();
    if (revision !== this.readRevision) return;
    for (const entry of entries) {
      const field = this.fields.get(entry.key);
      if (!field)
        this.fields.set(entry.key, {
          confirmed: confirmedEntry(entry),
          revision: 0,
        });
      else if (
        field.revision === revisions.get(field) &&
        field.draft === undefined &&
        !field.write
      ) {
        field.confirmed = confirmedEntry(entry);
        field.state = undefined;
        field.error = undefined;
      }
    }
    this.loaded = true;
    this.publish({ loadError: null });
  }

  load = (): Promise<void> => {
    if (this.loading) return this.loading;
    // Returning views join active work; a reload must not reset its field status.
    if (
      this.loaded &&
      (this.action ||
        [...this.fields.values()].some(
          (field) =>
            field.draft !== undefined ||
            field.write ||
            field.state === "checking",
        ))
    )
      return Promise.resolve();
    const revision = ++this.readRevision;
    this.publish({ loadError: null });
    this.loading = this.readEntries(revision)
      .then(() => {
        if (revision !== this.readRevision) return;
        for (const field of this.fields.values()) {
          if (
            verifiesAlone(field.confirmed.key) &&
            field.confirmed.configured &&
            field.draft === undefined &&
            !field.write
          )
            void this.verifyField(field, ++field.revision).catch(
              () => undefined,
            );
        }
        if (this.action) return;
        if (kaggleDeploymentRunning()) {
          // Capture the observed job before any continuation can let it finish.
          const deployment = kaggleDeployment(this.backend);
          void this.runKaggleAction("deploy", deployment).catch(
            () => undefined,
          );
          return;
        }
        // This optional lookup must not block editing the other environment fields.
        void this.backend
          .getAiProcessingSettings()
          .then((settings) => {
            if (
              revision === this.readRevision &&
              !this.action &&
              settings.processingBackend === "Kaggle" &&
              settings.kaggleConfigured &&
              this.fields.get("KAGGLE_API_TOKEN")?.confirmed.configured
            )
              return this.verifyKaggle();
          })
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (revision === this.readRevision) this.publish({ loadError: error });
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  };

  private requireField(key: string) {
    const field = this.fields.get(key);
    if (!field) throw new Error(`Unknown ENV key: ${key}`);
    return field;
  }

  private prepare(field: Field, value: string) {
    clearTimeout(field.debounce);
    field.debounce = undefined;
    field.revision++;
    field.draft = value;
    field.state = value.trim() ? "unverified" : "empty";
    field.error = undefined;
    return field;
  }

  change = (
    key: string,
    value: string,
    onError: (error: unknown) => void = () => undefined,
  ) => {
    const field = this.prepare(this.requireField(key), value);
    const revision = field.revision;
    // Clearing a secret draft keeps the confirmed secret; deletion is an explicit save.
    if (isSecret(field.confirmed) && !value.trim()) {
      field.draft = undefined;
      field.state = undefined;
    } else {
      field.debounce = setTimeout(() => {
        field.debounce = undefined;
        void this.enqueue(field, value, revision).catch(onError);
      }, saveDelayMilliseconds);
    }
    this.publish();
  };

  save = (key: string, value: string) => {
    const field = this.prepare(this.requireField(key), value);
    this.publish();
    return this.enqueue(field, value, field.revision);
  };

  private fail(field: Field, revision: number, error: unknown) {
    if (field.revision !== revision) return;
    field.state = "invalid";
    field.error = error;
    this.publish();
  }

  private async verifyField(field: Field, revision: number) {
    if (field.revision !== revision) return;
    field.state = "checking";
    field.error = undefined;
    const value = field.confirmed.value;
    this.publish();
    try {
      const verified = await this.backend.verifyEnvironmentSetting(
        field.confirmed.key,
      );
      if (field.revision !== revision) return;
      field.confirmed = confirmedEntry({ ...verified, value });
      field.state = undefined;
      this.publish();
    } catch (error) {
      this.fail(field, revision, error);
      throw error;
    }
  }

  private enqueue(
    field: Field,
    value: string,
    revision: number,
  ): Promise<void> {
    const previous = field.write ?? Promise.resolve();
    // A slow verification never holds this write queue.
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        if (field.revision !== revision) return null;
        field.state = "checking";
        this.publish();
        const stored = confirmedEntry(
          await this.backend.updateEnvironmentSetting(
            field.confirmed.key,
            value,
          ),
        );
        field.confirmed = stored;
        if (field.revision !== revision) return null;
        field.draft = undefined;
        field.error = undefined;
        return stored;
      })
      .catch((error: unknown) => {
        this.fail(field, revision, error);
        throw error;
      })
      .finally(() => {
        if (field.write === write) field.write = undefined;
        this.publish();
      });
    field.write = write;
    return write.then((stored) => {
      if (!stored || field.revision !== revision) return;
      if (
        verifiesAlone(stored.key) &&
        stored.configured &&
        stored.state !== "invalid"
      )
        return this.verifyField(field, revision);
      field.state = undefined;
      this.publish();
    });
  }

  applyJson = async (source: string) => {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("JSON must contain an object");
    const validated = Object.entries(parsed).map(([key, value]) => {
      const field = this.fields.get(key);
      if (!field || isSecret(field.confirmed) || typeof value !== "string")
        throw new Error(`Unsupported ENV value: ${key}`);
      return { field, value };
    });
    const changes: [Field, string, number][] = [];
    // Prepare every field before awaiting any write, cancelling all old debounces.
    for (const { field, value } of validated) {
      if (
        field.confirmed.value !== value ||
        field.draft !== undefined ||
        field.error !== undefined
      ) {
        this.prepare(field, value);
        changes.push([field, value, field.revision]);
      }
    }
    this.publish();
    const failures: string[] = [];
    for (const [field, value, revision] of changes) {
      try {
        await this.enqueue(field, value, revision);
      } catch (error) {
        failures.push(
          `${field.confirmed.key}: ${errorMessage(error) ?? "Could not save value"}`,
        );
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  };

  private beginKaggleCheck(): Check {
    const check = new Map<Field, number>();
    for (const field of this.fields.values()) {
      if (
        field.confirmed.group !== "kaggle" ||
        !field.confirmed.configured ||
        field.draft !== undefined ||
        field.write
      )
        continue;
      check.set(field, ++field.revision);
      field.state = "checking";
      field.error = undefined;
    }
    this.publish();
    return check;
  }

  private endKaggleCheck(check: Check, state: DisplayState, error?: unknown) {
    for (const [field, revision] of check) {
      if (field.revision !== revision) continue;
      field.state = state;
      field.error = error;
    }
    this.publish();
  }

  verifyKaggle = async () => {
    const check = this.beginKaggleCheck();
    try {
      const result = await this.backend.verifyKaggleSettings();
      this.endKaggleCheck(
        check,
        result.state === "valid" ? "valid" : "unverified",
      );
      return result;
    } catch (error) {
      this.endKaggleCheck(check, "invalid", error);
      throw error;
    }
  };

  runKaggleAction = (
    action: KaggleAction,
    existingDeployment?: ReturnType<typeof kaggleDeployment>,
  ): Promise<string> => {
    if (this.action) return this.action.promise;
    const run: KaggleRun = {
      phase: action,
      startedAt: null,
      promise: Promise.resolve().then(async () => {
        let check: Check = new Map();
        try {
          for (const field of this.fields.values()) {
            if (field.confirmed.group !== "kaggle") continue;
            if (field.draft !== undefined)
              await this.save(field.confirmed.key, field.draft);
            else if (field.write) await field.write;
          }
          check = this.beginKaggleCheck();
          if (action === "login") await this.backend.loginKaggle();
          const deployment =
            existingDeployment ?? kaggleDeployment(this.backend);
          run.phase = "deploy";
          run.startedAt = deployment.startedAt;
          this.publish();
          const result = await deployment.promise;
          await this.readEntries();
          const verification = await this.verifyKaggle();
          if (verification.state !== "valid")
            throw new Error(verification.message);
          return result.message;
        } catch (error) {
          this.endKaggleCheck(check, "invalid", error);
          throw error;
        } finally {
          this.action = null;
          this.publish();
        }
      }),
    };
    this.action = run;
    this.publish();
    return run.promise;
  };
}

const stores = new WeakMap<SettingsBackendPort, EnvironmentStore>();
export const environmentStoreFor = (backend: SettingsBackendPort) => {
  let store = stores.get(backend);
  if (!store) {
    store = new EnvironmentStore(backend);
    stores.set(backend, store);
  }
  return store;
};
