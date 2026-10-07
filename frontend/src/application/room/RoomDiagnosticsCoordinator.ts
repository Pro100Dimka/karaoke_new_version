import type { AudioServiceClient, RoomClient } from "../../contracts/clients";
import type { AudioBackendName } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";

type AudioPort = Pick<AudioServiceClient,
  "listDevices" | "preferredConfiguration" | "diagnosticsDump">;
type RoomPort = Pick<RoomClient, "publishDiagnostics">;

/** Publishes diagnostics for the current room only; a stopped session cannot upload a late read. */
export class RoomDiagnosticsCoordinator {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private deviceNames?: ReadonlyMap<string, string>;
  private previous?: Readonly<Record<string, string>>;
  private persistedBackend: AudioBackendName = "WASAPI Shared";

  constructor(
    private readonly scope: RoomSessionScope,
    private readonly audio: AudioPort,
    private readonly room: RoomPort,
  ) {}

  start(configuration: { backend: AudioBackendName }): void {
    this.persistedBackend = configuration.backend;
    if (this.timer) return;
    this.timer = setInterval(() => void this.upload(), 5000);
  }

  update(configuration: { backend: AudioBackendName }): void {
    this.persistedBackend = configuration.backend;
  }

  private upload(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.timer || !this.scope.isCurrent()) return Promise.resolve();
    const pending = (async () => {
      try {
        this.deviceNames ??= new Map((await this.audio.listDevices())
          .map((device) => [device.id, device.name]));
        const requested = this.audio.preferredConfiguration();
        const diagnostics = await this.audio.diagnosticsDump();
        if (!this.timer || !this.scope.isCurrent()) return;
        const acousticMicroseconds = Number(diagnostics.AcousticLatencyUs);
        const hiddenLatency = diagnostics.AcousticCalibrationValid === "1" &&
          Number.isFinite(acousticMicroseconds) && acousticMicroseconds >= 0 &&
          acousticMicroseconds <= 500_000
          ? String(acousticMicroseconds / 1000) : "unmeasured";
        const values: Readonly<Record<string, string>> = {
          ...diagnostics,
          "App.InputDevice": this.deviceNames.get(requested.inputDeviceId ?? "") ?? "default",
          "App.OutputDevice": this.deviceNames.get(requested.outputDeviceId ?? "") ?? "default",
          "App.RequestedBackend": requested.backend,
          "App.PersistedBackend": this.persistedBackend,
          "App.SettingsSelectedBackend": this.persistedBackend,
          "App.HiddenLatencyMs": hiddenLatency,
        };
        const previousBackend = this.previous?.Backend;
        if (previousBackend && values.Backend && previousBackend !== values.Backend) {
          await this.room.publishDiagnostics(this.scope.code, {
            ...this.previous, "App.BackendSwitchStage": "before",
            "App.BackendSwitchTo": values.Backend,
          });
          if (!this.timer || !this.scope.isCurrent()) return;
          await this.room.publishDiagnostics(this.scope.code, {
            ...values, "App.BackendSwitchStage": "after",
            "App.BackendSwitchFrom": previousBackend,
          });
        } else await this.room.publishDiagnostics(this.scope.code, values);
        if (this.timer && this.scope.isCurrent()) this.previous = values;
      } catch {
        // Diagnostics are best effort; the next interval retries.
      }
    })().finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
