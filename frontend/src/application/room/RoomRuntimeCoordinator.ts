import type { AudioServiceClient, DesktopClient, PythonClient, RoomClient } from "../../contracts/clients";
import type { AudioBackendName } from "../../contracts/models";
import type { RoomSessionController, RoomSessionScope } from "./RoomSessionController";
import { RoomDiagnosticsCoordinator } from "./RoomDiagnosticsCoordinator";
import { RoomLaunchCoordinator } from "./RoomLaunchCoordinator";
import { RoomProjectCoordinator } from "./RoomProjectCoordinator";
import { RoomRecoveryCoordinator } from "./RoomRecoveryCoordinator";
import { RoomVoiceCoordinator } from "./RoomVoiceCoordinator";
import type { RoomChimeKind } from "./roomChime";

type RuntimePorts = {
  room: Pick<RoomClient, "watchRoom" | "setRoomReadiness" | "publishLibrary" |
    "voiceLevels" | "setVoiceLatency" | "publishDiagnostics">;
  audio: Pick<AudioServiceClient, "joinVoiceSession" | "leaveVoiceSession" |
    "synchronizeRoomClock" | "setRoomPlayoutDelay" | "addRemoteParticipant" |
    "removeRemoteParticipant" | "playTestSound" | "roomLevels" | "roomTiming" |
    "reconnectVoiceSession" | "listDevices" | "preferredConfiguration" | "diagnosticsDump" |
    "microphoneEnabled" | "setMicrophoneEnabled" | "participantMuted" |
    "setParticipantMuted" | "setParticipantVolume" | "setParticipantEffect" |
    "monitoringEnabled" | "setMonitoring">;
  python: Pick<PythonClient, "listSongs" | "importProject" | "exportProject">;
  desktop: Pick<DesktopClient, "downloadRoomProject" | "uploadRoomProject" |
    "cancelRoomProjectTransfer" | "releaseRoomProjectDownload" |
    "onRoomProjectTransferProgress">;
  copies: { get(songId?: string, revision?: number): string | undefined;
    remember(songId: string, revision: number, localId: string): void };
  participantId: string;
};

export type RoomRuntimeView = {
  pathname(): string;
  navigate(songId: string): void;
  curtain(visible: boolean): void;
  notify(key: string, tone: "info" | "warning" | "error", params?: { name: string }): void;
  chime(kind: RoomChimeKind): void;
};

/** Composes one scope's bounded coordinators and stops all of them at the session boundary. */
export class RoomRuntimeCoordinator {
  private view?: RoomRuntimeView;
  private active?: { scope: RoomSessionScope; stop(): void;
    project: RoomProjectCoordinator; recovery: RoomRecoveryCoordinator;
    diagnostics: RoomDiagnosticsCoordinator; voice: RoomVoiceCoordinator };
  private pythonReady = false;
  private persistedBackend: AudioBackendName = "WASAPI Shared";
  private readonly unsubscribeSession: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly session: Pick<RoomSessionController, "getScope" | "subscribe">,
    private readonly ports: RuntimePorts,
  ) {
    this.unsubscribeSession = session.subscribe(() => this.sync());
  }

  attach(view: RoomRuntimeView): void {
    this.view = view;
    this.sync();
  }

  getProject(): RoomProjectCoordinator | null {
    return this.active?.project ?? null;
  }

  getVoice = (): RoomVoiceCoordinator | null => this.active?.voice ?? null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void { this.listeners.forEach((listener) => listener()); }


  detach(): void {
    this.view = undefined;
    this.stopActive();
    this.publish();
  }

  setPythonReady(ready: boolean): void {
    this.pythonReady = ready;
    this.active?.project.setPythonReady(ready);
    this.active?.recovery.setPythonReady(ready);
  }

  setPersistedBackend(backend: AudioBackendName): void {
    this.persistedBackend = backend;
    this.active?.diagnostics.update({ backend });
  }

  private stopActive(): void {
    if (!this.active) return;
    this.active?.stop();
    this.active = undefined;
    this.publish();
  }

  private sync(): void {
    const scope = this.session.getScope();
    const view = this.view;
    if (this.active?.scope === scope && view) return;
    this.stopActive();
    if (!scope || !view) return;
    const project = new RoomProjectCoordinator(scope, {
      room: this.ports.room, python: this.ports.python,
      desktop: this.ports.desktop, copies: this.ports.copies,
      participantId: this.ports.participantId,
      onFailure: (conflict, error) => {
        console.error("Room project download/import failed", error);
        view.notify(conflict ? "roomProjectConflict" : "roomNetworkUnavailable",
          conflict ? "warning" : "error");
      },
    });
    const voice = new RoomVoiceCoordinator(scope, this.ports.audio, this.ports.participantId);
    const launch = new RoomLaunchCoordinator(scope, project, this.ports.copies.get, view);
    const recovery = new RoomRecoveryCoordinator(scope, {
      room: this.ports.room, audio: this.ports.audio, python: this.ports.python,
      voice, project, launch, notify: view.notify, chime: view.chime,
    });
    const diagnostics = new RoomDiagnosticsCoordinator(scope, this.ports.audio, this.ports.room);
    this.active = { scope, project, recovery, diagnostics, voice,
      stop: () => {
        recovery.stop();
        launch.stop();
        project.stop();
        voice.stop();
        diagnostics.stop();
      } };
    project.start();
    project.setPythonReady(this.pythonReady);
    voice.startPolls(this.ports.room);
    recovery.setPythonReady(this.pythonReady);
    recovery.start();
    diagnostics.start({ backend: this.persistedBackend });
    this.publish();
  }

  dispose(): void {
    this.unsubscribeSession();
    this.detach();
    this.listeners.clear();
  }
}
