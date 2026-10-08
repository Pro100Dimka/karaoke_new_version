import type {
  AudioServiceClient, RoomClient, RoomRouteStages, RoomTimingReport,
} from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import type { RoomSessionScope } from "./RoomSessionController";
import { publishSpeakingLevels } from "./roomSpeakingLevelsStore";
import { reconcileRemoteParticipants, restoreRoomVoiceAfterReconnect } from "./roomModel";
import { calibrationDelayMilliseconds, scheduleCalibrationClicks } from "./roomSyncCheck";

type VoicePort = Pick<AudioServiceClient,
  "joinVoiceSession" | "synchronizeRoomClock" | "setRoomPlayoutDelay" |
  "addRemoteParticipant" | "removeRemoteParticipant" | "playTestSound" |
  "roomLevels" | "roomTiming" | "reconnectVoiceSession" |
  "microphoneEnabled" | "setMicrophoneEnabled" | "participantMuted" |
  "setParticipantMuted" | "setParticipantVolume" | "setParticipantEffect" |
  "monitoringEnabled" | "setMonitoring" | "snapshot">;

const publishedMilliseconds = (value: number): number =>
  Math.round(Math.max(0, Math.min(500, value)) * 10) / 10;
const routeStagesOf = (report: RoomTimingReport): RoomRouteStages | undefined =>
  report.returnRequirementMs === undefined || report.arrivalRequirementMs === undefined
    ? undefined
    : { returnRequirementMs: publishedMilliseconds(report.returnRequirementMs),
        arrivalRequirementMs: publishedMilliseconds(report.arrivalRequirementMs) };

/** Applies authoritative room timing and manages only this session's remote voice registrations. */
export class RoomVoiceCoordinator {
  private readonly registered = new Set<string>();
  private readonly calibrationCancels = new Set<() => void>();
  private syncCheckId = 0;
  private stopPolling?: () => void;
  private readonly timingSubscriptions = new Set<() => void>();

  constructor(
    private readonly scope: RoomSessionScope,
    private readonly audio: VoicePort,
    private readonly participantId: string,
  ) {
    this.syncCheckId = scope.getRoom()?.syncCheckId ?? 0;
  }

  registeredParticipants = (): readonly string[] => [...this.registered];

  microphoneEnabled(): boolean { return this.audio.microphoneEnabled(); }
  participantMuted(id: string): boolean { return this.audio.participantMuted(id); }
  monitoringEnabled(): boolean { return this.audio.monitoringEnabled(); }
  monitoringStatus(): ReturnType<VoicePort["snapshot"]> { return this.audio.snapshot(); }

  setMicrophoneEnabled(enabled: boolean): Promise<void> {
    return this.scope.isCurrent() ? this.audio.setMicrophoneEnabled(enabled) : Promise.resolve();
  }

  setParticipantMuted(id: string, muted: boolean): Promise<void> {
    return this.scope.isCurrent() ? this.audio.setParticipantMuted(id, muted) : Promise.resolve();
  }

  setParticipantVolume(id: string, gain: number): Promise<void> {
    return this.scope.isCurrent() ? this.audio.setParticipantVolume(id, gain) : Promise.resolve();
  }

  setParticipantEffect(id: string, effect: Parameters<VoicePort["setParticipantEffect"]>[1],
    value: number): Promise<void> {
    return this.scope.isCurrent()
      ? this.audio.setParticipantEffect(id, effect, value) : Promise.resolve();
  }

  setMonitoring(enabled: boolean): ReturnType<VoicePort["setMonitoring"]> {
    return this.scope.isCurrent()
      ? this.audio.setMonitoring(enabled)
      : Promise.reject(new DOMException("Room session ended", "AbortError"));
  }

  subscribeTiming(listener: (report: RoomTimingReport) => void): () => void {
    let active = true;
    const refresh = () => {
      if (!active || !this.scope.isCurrent()) return;
      void this.audio.roomTiming().then((report) => {
        if (active && this.scope.isCurrent()) listener(report);
      }).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    const cancel = () => {
      active = false;
      clearInterval(timer);
      this.timingSubscriptions.delete(cancel);
    };
    this.timingSubscriptions.add(cancel);
    return cancel;
  }

  startPolls(room: Pick<RoomClient, "voiceLevels" | "setVoiceLatency">): void {
    if (this.stopPolling) return;
    let active = true;
    let levelPending: Promise<void> | undefined;
    let timingPending: Promise<void> | undefined;
    let lastPublished = -1;
    let lastStagesPublished: RoomRouteStages | undefined;
    let lastMixMeasured = false;
    let previousTransport: { packetsSent: number; relayEchoes: number } | undefined;
    let stalledRelaySamples = 0;
    let reconnectAfter = 0;
    const levels = () => {
      if (levelPending || !this.scope.isCurrent()) return;
      const pending = Promise.all([this.audio.roomLevels(), room.voiceLevels()])
        .then(([local, remote]) => {
          if (active && this.scope.isCurrent())
            publishSpeakingLevels({ local: local.local, remote });
        })
        .catch(() => undefined)
        .then(() => { if (levelPending === pending) levelPending = undefined; });
      levelPending = pending;
    };
    const timing = () => {
      if (timingPending || !this.scope.isCurrent()) return;
      const pending = (async () => {
        try {
          const report = await this.audio.roomTiming();
          if (!active || !this.scope.isCurrent()) return;
          const sending = report.networkTransportRunning && report.networkSendEnabled &&
            previousTransport !== undefined && report.packetsSent > previousTransport.packetsSent;
          const relayResponded = previousTransport === undefined ||
            report.relayEchoes > previousTransport.relayEchoes;
          stalledRelaySamples = sending && !relayResponded ? stalledRelaySamples + 1 : 0;
          previousTransport = { packetsSent: report.packetsSent, relayEchoes: report.relayEchoes };
          if (stalledRelaySamples >= 3 && Date.now() >= reconnectAfter) {
            reconnectAfter = Date.now() + 5000;
            stalledRelaySamples = 0;
            await this.audio.reconnectVoiceSession();
            if (!active || !this.scope.isCurrent()) return;
          }
          const probeReady = report.networkTransportRunning && report.networkSendEnabled &&
            report.packetsSent >= 800 && report.relayEchoes > 0;
          if (!probeReady) return;
          const mixMeasured = report.packetsReceived >= 800;
          const independentLatency = mixMeasured
            ? (report.requestedVoiceDelayMs ?? report.estimatedVoiceLatencyMs)
            : report.estimatedVoiceLatencyMs;
          const latency = publishedMilliseconds(independentLatency);
          const stages = mixMeasured ? routeStagesOf(report) : undefined;
          const stagesMoved = stages !== undefined &&
            (lastStagesPublished === undefined ||
              Math.abs(stages.returnRequirementMs - lastStagesPublished.returnRequirementMs) >= 1 ||
              Math.abs(stages.arrivalRequirementMs - lastStagesPublished.arrivalRequirementMs) >= 1);
          if (Math.abs(latency - lastPublished) < 1 && !stagesMoved &&
              mixMeasured === lastMixMeasured) return;
          const updated = await room.setVoiceLatency(this.scope.code, latency, stages, mixMeasured);
          if (!active || !this.scope.isCurrent()) return;
          await this.audio.setRoomPlayoutDelay(updated.roomPlayoutDelayMs ?? 10);
          if (!active || !this.scope.isCurrent()) return;
          lastPublished = latency;
          lastStagesPublished = stages;
          lastMixMeasured = mixMeasured;
          this.scope.setSnapshot(updated);
        } catch {
          // Later measurements retry with the last stable deadline.
        }
      })().finally(() => { if (timingPending === pending) timingPending = undefined; });
      timingPending = pending;
    };
    levels();
    timing();
    const levelTimer = setInterval(levels, 80);
    const timingTimer = setInterval(timing, 1000);
    this.stopPolling = () => {
      active = false;
      clearInterval(levelTimer);
      clearInterval(timingTimer);
      publishSpeakingLevels();
      this.stopPolling = undefined;
    };
  }

  async synchronize(
    before: RoomStateDto,
    after: RoomStateDto,
    selectionIsCurrent: () => boolean = () => true,
  ): Promise<void> {
    const current = () => this.scope.isCurrent() && selectionIsCurrent();
    if (!current()) return;
    if (restoreRoomVoiceAfterReconnect(before, after)) {
      await this.audio.joinVoiceSession(
        this.scope.code, this.participantId, after.serverClockOffsetMilliseconds,
      );
      if (!current()) return;
    }
    await this.audio.synchronizeRoomClock(after.serverClockOffsetMilliseconds);
    if (!current()) return;
    // The server's deadline is applied to all participants without local adaptation.
    await this.audio.setRoomPlayoutDelay(after.roomPlayoutDelayMs ?? 10);
    if (!current()) return;
    const syncCheckId = after.syncCheckId ?? 0;
    if (syncCheckId > this.syncCheckId && after.syncCheckStartedAt && after.serverNow) {
      this.syncCheckId = syncCheckId;
      const delay = calibrationDelayMilliseconds(after.syncCheckStartedAt, after.serverNow, 0);
      this.calibrationCancels.add(scheduleCalibrationClicks(delay, () => this.audio.playTestSound()));
    }
    const change = reconcileRemoteParticipants(this.registered, after);
    for (const id of change.add) {
      await this.audio.addRemoteParticipant(id);
      if (!current()) return;
      this.registered.add(id);
    }
    for (const id of change.remove) {
      await this.audio.removeRemoteParticipant(id).catch(() => undefined);
      if (!current()) return;
      this.registered.delete(id);
    }
  }

  stop(): void {
    this.stopPolling?.();
    this.timingSubscriptions.forEach((cancel) => cancel());
    if (!this.audio.microphoneEnabled())
      void this.audio.setMicrophoneEnabled(true).catch(() => undefined);
    this.calibrationCancels.forEach((cancel) => cancel());
    this.calibrationCancels.clear();
    this.registered.clear();
  }
}
