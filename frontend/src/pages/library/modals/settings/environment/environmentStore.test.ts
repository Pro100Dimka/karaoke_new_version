import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsBackendPort } from "../../../../../application/settings/SettingsPorts";
import type { EnvironmentSettingDto } from "../../../../../contracts/models";
import {
  kaggleDeployment,
  kaggleDeploymentRunning,
} from "../../../../../application/settings/KaggleDeployment";
import { EnvironmentStore, environmentStoreFor } from "./environmentStore";
import { groupState, valuesOf } from "./environmentModel";

// The app-level deployment coordinator is outside this module. Exercise our ownership here.
vi.mock("../../../../../application/settings/KaggleDeployment", () => {
  let active: {
    startedAt: number;
    promise: ReturnType<SettingsBackendPort["deployKaggle"]>;
  } | null = null;
  return {
    kaggleDeploymentRunning: vi.fn(() => active !== null),
    kaggleDeployment: (backend: SettingsBackendPort) => {
      if (active) return active;
      const job = { startedAt: Date.now(), promise: backend.deployKaggle() };
      active = job;
      const finished = () => {
        if (active === job) active = null;
      };
      void job.promise.then(finished, finished);
      return job;
    },
  };
});

const relay: EnvironmentSettingDto = {
  key: "AD_VOICE_ROOM_SERVER_RELAY_PORT",
  group: "room",
  kind: "port",
  value: "40000",
  configured: true,
  state: "valid",
  message: "Valid",
};
const token: EnvironmentSettingDto = {
  key: "AD_VOICE_AUDD_TOKEN",
  group: "recognition",
  kind: "secret",
  value: "",
  configured: false,
  state: "empty",
  message: "Not configured",
};
const account: EnvironmentSettingDto = {
  ...token,
  key: "KAGGLE_API_TOKEN",
  group: "kaggle",
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let step = 0; step < 12; step++) await Promise.resolve();
};
const setup = (entries: EnvironmentSettingDto[] = [relay]) => {
  const persisted = new Map(entries.map((entry) => [entry.key, { ...entry }]));
  const methods = {
    listEnvironmentSettings: vi.fn(async () =>
      [...persisted.values()].map((entry) => ({ ...entry })),
    ),
    updateEnvironmentSetting: vi.fn(async (key: string, value: string) => {
      const entry = persisted.get(key)!;
      const saved: EnvironmentSettingDto = {
        ...entry,
        value: entry.kind === "secret" ? "" : value,
        configured: Boolean(value.trim()),
        state: value.trim() ? "unverified" : "empty",
      };
      persisted.set(key, saved);
      return saved;
    }),
    verifyEnvironmentSetting: vi.fn(
      async (key: string): Promise<EnvironmentSettingDto> => ({
        ...persisted.get(key)!,
        state: "valid",
      }),
    ),
    getAiProcessingSettings: vi.fn(async () => ({
      processingBackend: "Local",
      kaggleConfigured: false,
    })),
    updateAiProcessingSettings: vi.fn(),
    verifyKaggleSettings: vi.fn(
      async (): Promise<{ state: "valid" | "invalid"; message: string }> => ({
        state: "valid",
        message: "Available",
      }),
    ),
    loginKaggle: vi.fn(async () => ({ state: "valid", message: "Signed in" })),
    deployKaggle: vi.fn(async () => ({
      state: "valid",
      message: "Started",
      url: "https://example.test/notebook",
    })),
  };
  const backend = methods as unknown as SettingsBackendPort;
  return { backend, methods, persisted, store: new EnvironmentStore(backend) };
};
const entryOf = (store: EnvironmentStore, key: string) =>
  store.getSnapshot().entries!.find((entry) => entry.key === key)!;

describe("environment persistence and verification", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recovers from an initial load failure when retried", async () => {
    const { store, methods } = setup();
    const error = new Error("Backend unavailable");
    methods.listEnvironmentSettings.mockRejectedValueOnce(error);
    await store.load();
    expect(store.getSnapshot().loadError).toBe(error);
    await store.load();
    await settle();
    expect(entryOf(store, relay.key).value).toBe("40000");
    expect(store.getSnapshot().loadError).toBeNull();
    expect(methods.listEnvironmentSettings).toHaveBeenCalledTimes(2);
  });

  it("does not invent a saved secret when an unsaved draft is erased", async () => {
    const { store, methods } = setup([token]);
    await store.load();
    store.change(token.key, "temporary");
    store.change(token.key, "");
    await vi.advanceTimersByTimeAsync(500);
    expect(methods.updateEnvironmentSetting).not.toHaveBeenCalled();
    expect(entryOf(store, token.key)).toMatchObject({
      value: "",
      configured: false,
      state: "empty",
    });
  });

  it("retains a confirmed secret when its replacement draft is erased", async () => {
    const { store, methods } = setup([
      { ...token, configured: true, state: "valid" },
    ]);
    await store.load();
    await settle();
    store.change(token.key, "replacement");
    store.change(token.key, "");
    await vi.advanceTimersByTimeAsync(500);
    expect(methods.updateEnvironmentSetting).not.toHaveBeenCalled();
    expect(entryOf(store, token.key)).toMatchObject({
      value: "",
      configured: true,
      state: "valid",
    });
    await store.save(token.key, "");
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledExactlyOnceWith(
      token.key,
      "",
    );
    expect(entryOf(store, token.key)).toMatchObject({
      configured: false,
      state: "empty",
    });
  });

  it("saves a Kaggle account token without changing the processing backend or deploying", async () => {
    const { store, methods } = setup([account]);
    const credential = "personal-kaggle-token";
    methods.updateEnvironmentSetting.mockResolvedValueOnce({
      ...account,
      value: credential,
      configured: true,
      state: "unverified",
    });
    await store.load();
    await settle();
    store.change(account.key, credential);
    await vi.advanceTimersByTimeAsync(500);
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledExactlyOnceWith(
      account.key,
      credential,
    );
    expect(entryOf(store, account.key)).toMatchObject({
      value: "",
      configured: true,
      state: "unverified",
    });
    expect(methods.updateAiProcessingSettings).not.toHaveBeenCalled();
    expect(methods.deployKaggle).not.toHaveBeenCalled();
  });

  it("ends checking when verification rejects after a secret was saved", async () => {
    const { store, methods } = setup([token]);
    await store.load();
    methods.verifyEnvironmentSetting.mockRejectedValueOnce(
      new Error("Verification offline"),
    );
    await expect(store.save(token.key, "new-token")).rejects.toThrow(
      "Verification offline",
    );
    expect(entryOf(store, token.key)).toMatchObject({
      value: "",
      configured: true,
      state: "invalid",
      errorMessage: "Verification offline",
    });
  });

  it("ignores an old initial verification after a new secret was saved", async () => {
    const { store, methods } = setup([
      { ...token, configured: true, state: "valid" },
    ]);
    const initial = deferred<EnvironmentSettingDto>();
    methods.verifyEnvironmentSetting.mockImplementationOnce(
      () => initial.promise,
    );
    await store.load();
    await store.save(token.key, "new-token");
    initial.resolve({
      ...token,
      configured: true,
      state: "invalid",
      message: "Old token rejected",
    });
    await settle();
    expect(entryOf(store, token.key)).toMatchObject({
      value: "",
      configured: true,
      state: "valid",
    });
  });

  it("serializes writes of the same key so an older write cannot finish last", async () => {
    const { store, methods, persisted } = setup();
    await store.load();
    await settle();
    const first = deferred<EnvironmentSettingDto>();
    methods.updateEnvironmentSetting.mockImplementationOnce(
      () => first.promise,
    );
    const oldSave = store.save(relay.key, "41000");
    await settle();
    const newSave = store.save(relay.key, "42000");
    await settle();
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledTimes(1);
    first.resolve({ ...relay, value: "41000" });
    await Promise.all([oldSave, newSave]);
    expect(
      methods.updateEnvironmentSetting.mock.calls.map(([, value]) => value),
    ).toEqual(["41000", "42000"]);
    expect(persisted.get(relay.key)?.value).toBe("42000");
    expect(entryOf(store, relay.key)).toMatchObject({
      value: "42000",
      state: "valid",
    });
  });

  it("allows a new write while an old verification is pending and rejects its stale result", async () => {
    const { store, methods } = setup();
    await store.load();
    await settle();
    const oldCheck = deferred<EnvironmentSettingDto>();
    methods.verifyEnvironmentSetting.mockImplementationOnce(
      () => oldCheck.promise,
    );
    const oldSave = store.save(relay.key, "41000");
    await settle();
    await store.save(relay.key, "42000");
    oldCheck.resolve({ ...relay, value: "41000", state: "invalid" });
    await oldSave;
    expect(entryOf(store, relay.key)).toMatchObject({
      value: "42000",
      state: "valid",
    });
  });

  it("does not restore an old reload snapshot after a newer save finishes", async () => {
    const { store, methods } = setup();
    await store.load();
    await settle();
    const oldList = deferred<EnvironmentSettingDto[]>();
    methods.listEnvironmentSettings.mockImplementationOnce(
      () => oldList.promise,
    );
    const reloading = store.load();
    await store.save(relay.key, "42000");
    oldList.resolve([{ ...relay }]);
    await reloading;
    await settle();
    expect(entryOf(store, relay.key)).toMatchObject({
      value: "42000",
      state: "valid",
    });
  });

  it("shares a pending debounce with a remounted view and does not restore the old server value", async () => {
    const { backend, methods } = setup();
    const first = environmentStoreFor(backend);
    const leave = first.subscribe(() => undefined);
    await first.load();
    await settle();
    methods.verifyEnvironmentSetting.mockClear();
    first.change(relay.key, "41000");
    leave();
    await vi.advanceTimersByTimeAsync(100);
    const second = environmentStoreFor(backend);
    expect(second).toBe(first);
    const leaveAgain = second.subscribe(() => undefined);
    await second.load();
    expect(entryOf(second, relay.key).value).toBe("41000");
    await vi.advanceTimersByTimeAsync(500);
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledExactlyOnceWith(
      relay.key,
      "41000",
    );
    expect(methods.verifyEnvironmentSetting).toHaveBeenCalledExactlyOnceWith(
      relay.key,
    );
    expect(entryOf(second, relay.key)).toMatchObject({
      value: "41000",
      state: "valid",
    });
    leaveAgain();
  });

  it("finishes a pending debounce after the last subscriber leaves", async () => {
    const { backend, methods } = setup();
    const store = environmentStoreFor(backend);
    const leave = store.subscribe(() => undefined);
    await store.load();
    await settle();
    store.change(relay.key, "41000");
    leave();
    await vi.advanceTimersByTimeAsync(500);
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledExactlyOnceWith(
      relay.key,
      "41000",
    );
  });

  it("preserves an in-flight write across remounts and refreshes external changes on return", async () => {
    const { backend, methods, persisted } = setup();
    const first = environmentStoreFor(backend);
    const leave = first.subscribe(() => undefined);
    await first.load();
    await settle();
    const write = deferred<EnvironmentSettingDto>();
    methods.updateEnvironmentSetting.mockImplementationOnce(
      () => write.promise,
    );
    const saving = first.save(relay.key, "41000");
    await settle();
    leave();
    const second = environmentStoreFor(backend);
    expect(second).toBe(first);
    const leaveAgain = second.subscribe(() => undefined);
    await second.load();
    write.resolve({ ...relay, value: "41000" });
    await saving;
    expect(entryOf(second, relay.key).value).toBe("41000");
    leaveAgain();
    await vi.advanceTimersByTimeAsync(0);
    const next = environmentStoreFor(backend);
    persisted.set(relay.key, { ...relay, value: "43000" });
    await next.load();
    expect(entryOf(next, relay.key).value).toBe("43000");
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledExactlyOnceWith(
      relay.key,
      "41000",
    );
  });

  it("keeps an active verification visible when the tab returns", async () => {
    const { backend, methods } = setup();
    const store = environmentStoreFor(backend);
    await store.load();
    await settle();
    const checking = deferred<EnvironmentSettingDto>();
    methods.verifyEnvironmentSetting.mockImplementationOnce(
      () => checking.promise,
    );
    const saving = store.save(relay.key, "41000");
    await settle();
    const reads = methods.listEnvironmentSettings.mock.calls.length;
    await environmentStoreFor(backend).load();
    expect(methods.listEnvironmentSettings).toHaveBeenCalledTimes(reads);
    expect(entryOf(store, relay.key)).toMatchObject({
      value: "41000",
      state: "checking",
    });
    checking.resolve({ ...relay, value: "41000", state: "valid" });
    await saving;
    expect(entryOf(store, relay.key).state).toBe("valid");
  });

  it("ignores optional AI settings from an older reload", async () => {
    const { store, methods } = setup([
      { ...account, configured: true, state: "unverified" },
    ]);
    const oldSettings = deferred<{
      processingBackend: string;
      kaggleConfigured: boolean;
    }>();
    methods.getAiProcessingSettings.mockImplementationOnce(
      () => oldSettings.promise,
    );
    await store.load();
    await store.load();
    oldSettings.resolve({
      processingBackend: "Kaggle",
      kaggleConfigured: true,
    });
    await settle();
    expect(methods.verifyKaggleSettings).not.toHaveBeenCalled();
  });

  it("keeps ENV usable when the optional AI settings request fails", async () => {
    const { store, methods } = setup();
    methods.getAiProcessingSettings.mockRejectedValueOnce(
      new Error("AI unavailable"),
    );
    await store.load();
    await settle();
    expect(store.getSnapshot().loadError).toBeNull();
    expect(entryOf(store, relay.key).value).toBe("40000");
    await store.save(relay.key, "41000");
    expect(entryOf(store, relay.key).value).toBe("41000");
  });

  it("does not check or start Kaggle when settings open with local processing selected", async () => {
    const { store, methods } = setup([
      { ...account, configured: true, state: "unverified" },
    ]);
    methods.getAiProcessingSettings.mockResolvedValue({
      processingBackend: "Local",
      kaggleConfigured: true,
    });
    await store.load();
    await settle();
    expect(methods.verifyKaggleSettings).not.toHaveBeenCalled();
    expect(methods.deployKaggle).not.toHaveBeenCalled();
  });

  it("leaves Kaggle controls recoverable after a rejected initial check", async () => {
    const { store, methods } = setup([
      { ...account, configured: true, state: "unverified" },
    ]);
    methods.getAiProcessingSettings.mockResolvedValue({
      processingBackend: "Kaggle",
      kaggleConfigured: true,
    });
    methods.verifyKaggleSettings.mockRejectedValueOnce(
      new Error("Kaggle offline"),
    );
    await store.load();
    await settle();
    expect(groupState(store.getSnapshot().entries!)).toBe("invalid");
    expect(entryOf(store, account.key).errorMessage).toBe("Kaggle offline");
    await store.verifyKaggle();
    expect(groupState(store.getSnapshot().entries!)).toBe("valid");
  });

  it("does not report a successful deployment when the notebook remains unavailable", async () => {
    const { store, methods } = setup([
      { ...account, configured: true, state: "unverified" },
    ]);
    methods.getAiProcessingSettings.mockResolvedValue({
      processingBackend: "Kaggle",
      kaggleConfigured: true,
    });
    methods.verifyKaggleSettings.mockResolvedValue({
      state: "invalid",
      message: "Notebook unavailable",
    });
    await store.load();
    await settle();
    expect(methods.verifyKaggleSettings).toHaveBeenCalledOnce();
    expect(groupState(store.getSnapshot().entries!)).toBe("unverified");
    expect(methods.deployKaggle).not.toHaveBeenCalled();

    const deployment = deferred<{
      state: string;
      message: string;
      url: string;
    }>();
    methods.deployKaggle.mockImplementationOnce(() => deployment.promise);
    const running = store.runKaggleAction("deploy");
    await settle();
    expect(store.getSnapshot().kaggleAction).toBe("deploy");
    expect(groupState(store.getSnapshot().entries!)).toBe("checking");
    expect(entryOf(store, account.key).errorMessage).toBeUndefined();
    deployment.resolve({
      state: "valid",
      message: "Started",
      url: "https://example.test/notebook",
    });
    await expect(running).rejects.toThrow("Notebook unavailable");
    expect(groupState(store.getSnapshot().entries!)).toBe("unverified");
    expect(store.getSnapshot().kaggleAction).toBeNull();
  });

  it("cancels every JSON field debounce before a slow first save", async () => {
    const port = { ...relay, key: "AD_VOICE_ROOM_SERVER_PORT", value: "8081" };
    const { store, methods } = setup([port, relay]);
    await store.load();
    await settle();
    expect(valuesOf(store.getSnapshot().entries!)).toEqual({
      [port.key]: "8081",
      [relay.key]: "40000",
    });
    const first = deferred<EnvironmentSettingDto>();
    methods.updateEnvironmentSetting.mockImplementationOnce(
      () => first.promise,
    );
    store.change(relay.key, "41000");
    expect(valuesOf(store.getSnapshot().entries!)[relay.key]).toBe("41000");
    const applying = store.applyJson(
      JSON.stringify({ [port.key]: "8181", [relay.key]: "42000" }),
    );
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledExactlyOnceWith(
      port.key,
      "8181",
    );
    first.resolve({ ...port, value: "8181" });
    await applying;
    expect(methods.updateEnvironmentSetting.mock.calls).toEqual([
      [port.key, "8181"],
      [relay.key, "42000"],
    ]);
    expect(entryOf(store, relay.key).value).toBe("42000");
    expect(valuesOf(store.getSnapshot().entries!)).toEqual({
      [port.key]: "8181",
      [relay.key]: "42000",
    });
  });

  it("reports partial JSON failures and retries the unchanged failed draft", async () => {
    const port = { ...relay, key: "AD_VOICE_ROOM_SERVER_PORT", value: "8081" };
    const { store, methods } = setup([port, relay]);
    await store.load();
    await settle();
    methods.updateEnvironmentSetting.mockRejectedValueOnce(
      new Error("Write failed"),
    );
    const source = JSON.stringify({ [port.key]: "8181", [relay.key]: "42000" });
    await expect(store.applyJson(source)).rejects.toThrow(
      `${port.key}: Write failed`,
    );
    expect(entryOf(store, port.key)).toMatchObject({
      value: "8181",
      state: "invalid",
    });
    expect(entryOf(store, relay.key)).toMatchObject({
      value: "42000",
      state: "valid",
    });
    await store.applyJson(source);
    expect(entryOf(store, port.key)).toMatchObject({
      value: "8181",
      state: "valid",
    });
    expect(methods.updateEnvironmentSetting).toHaveBeenCalledTimes(3);
  });

  it("validates the whole JSON before mutation and keeps write-only secrets out", async () => {
    const { store, methods } = setup([relay, token]);
    await store.load();
    await settle();
    expect(valuesOf(store.getSnapshot().entries!)).not.toHaveProperty(
      token.key,
    );
    await expect(
      store.applyJson(
        JSON.stringify({ [relay.key]: "42000", [token.key]: "secret" }),
      ),
    ).rejects.toThrow("Unsupported ENV value");
    expect(entryOf(store, relay.key).value).toBe("40000");
    expect(methods.updateEnvironmentSetting).not.toHaveBeenCalled();
  });

  it("shares one deployment across a remount and refreshes the saved account afterwards", async () => {
    const { backend, methods, persisted } = setup([account]);
    const first = environmentStoreFor(backend);
    const leave = first.subscribe(() => undefined);
    await first.load();
    await settle();
    const deployment = deferred<{
      state: string;
      message: string;
      url: string;
    }>();
    methods.deployKaggle.mockImplementationOnce(() => deployment.promise);
    const running = first.runKaggleAction("login");
    await settle();
    leave();
    const second = environmentStoreFor(backend);
    const leaveAgain = second.subscribe(() => undefined);
    await second.load();
    const resumed = second.runKaggleAction("deploy");
    expect(methods.loginKaggle).toHaveBeenCalledOnce();
    expect(methods.deployKaggle).toHaveBeenCalledTimes(1);
    persisted.set(account.key, {
      ...account,
      configured: true,
      state: "unverified",
    });
    deployment.resolve({
      state: "valid",
      message: "Started",
      url: "https://example.test/notebook",
    });
    await Promise.all([running, resumed]);
    expect(entryOf(second, account.key)).toMatchObject({
      configured: true,
      state: "valid",
    });
    expect(second.getSnapshot().kaggleAction).toBeNull();
    await second.runKaggleAction("deploy");
    expect(methods.deployKaggle).toHaveBeenCalledTimes(2);
    leaveAgain();
  });

  it("joins the observed deployment even if it finishes before the resume continuation", async () => {
    const { backend, methods, store } = setup([
      { ...account, configured: true, state: "unverified" },
    ]);
    const existing = deferred<{
      state: string;
      message: string;
      url: string;
    }>();
    methods.deployKaggle.mockImplementationOnce(() => existing.promise);
    kaggleDeployment(backend);
    // Observe the job while its resolved promise has queued coordinator cleanup.
    vi.mocked(kaggleDeploymentRunning).mockImplementationOnce(() => {
      existing.resolve({
        state: "valid",
        message: "Already started",
        url: "https://example.test/notebook",
      });
      return true;
    });
    await store.load();
    await settle();
    expect(methods.deployKaggle).toHaveBeenCalledTimes(1);
    expect(methods.verifyKaggleSettings).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().kaggleAction).toBeNull();
  });
});
