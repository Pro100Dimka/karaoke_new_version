import { useEffect, type MutableRefObject } from "react";
import { audioClient } from "../../services/audioClient";
import { roomClient } from "../../services/roomClient";
import type { RoomRouteStages, RoomTimingReport } from "../../contracts/clients";
import type { RoomStateDto } from "../../contracts/models";
import { publishSpeakingLevels } from "./roomSpeakingLevels";

// The room levels are pushed over the persistent social socket; this only reads Electron's local
// cache, so a smooth meter no longer contends with the server's real-time UDP mixer.
const levelPollMilliseconds = 80;
const timingPollMilliseconds = 1000;
const missingRelayEchoSamples = 3;
const voiceReconnectCooldownMilliseconds = 5000;
const minimumTimingPackets = 800;

const publishedMilliseconds = (value: number): number => Math.round(Math.max(0, Math.min(500, value)) * 10) / 10;
const routeStagesOf = (report: RoomTimingReport): RoomRouteStages | undefined =>
  report.returnRequirementMs === undefined || report.arrivalRequirementMs === undefined
    ? undefined
    : {
      returnRequirementMs: publishedMilliseconds(report.returnRequirementMs),
      arrivalRequirementMs: publishedMilliseconds(report.arrivalRequirementMs),
    };

/** Shows who is speaking and publishes this computer's voice latency to the room. */
export const useRoomVoicePolls = (
  code: string | undefined,
  roomRef: MutableRefObject<RoomStateDto | null>,
  setRoom: (room: RoomStateDto | null) => void,
): void => {
  useEffect(() => {
    if (!code) return;
    let active = true;
    let polling = false;
    const updateLevels = async () => {
      if (polling) return;
      polling = true;
      try {
        const [localLevels, participantLevels] = await Promise.all([
          audioClient.roomLevels(),
          roomClient.voiceLevels(),
        ]);
        if (active) publishSpeakingLevels({ local: localLevels.local, remote: participantLevels });
      } catch {
        // A transient diagnostics miss must not disconnect an otherwise healthy room.
      } finally {
        polling = false;
      }
    };
    void updateLevels();
    const timer = window.setInterval(() => void updateLevels(), levelPollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
      publishSpeakingLevels();
    };
  }, [code]);

  useEffect(() => {
    if (!code) return;
    let active = true;
    let publishing = false;
    let lastPublished = -1;
    let lastStagesPublished: RoomRouteStages | undefined;
    let previousTransport: { packetsSent: number; relayEchoes: number } | undefined;
    let stalledRelaySamples = 0;
    let reconnectAfter = 0;
    const publishTiming = async () => {
      if (publishing) return;
      publishing = true;
      try {
        const report = await audioClient.roomTiming();
        if (!active || roomRef.current?.code !== code) return;
        const sending = report.networkTransportRunning && report.networkSendEnabled
          && previousTransport !== undefined && report.packetsSent > previousTransport.packetsSent;
        const relayResponded = previousTransport === undefined
          || report.relayEchoes > previousTransport.relayEchoes;
        stalledRelaySamples = sending && !relayResponded ? stalledRelaySamples + 1 : 0;
        previousTransport = { packetsSent: report.packetsSent, relayEchoes: report.relayEchoes };
        if (stalledRelaySamples >= missingRelayEchoSamples && Date.now() >= reconnectAfter) {
          reconnectAfter = Date.now() + voiceReconnectCooldownMilliseconds;
          stalledRelaySamples = 0;
          await audioClient.reconnectVoiceSession();
          if (!active) return;
        }
        const routeMeasured = report.networkTransportRunning && report.networkSendEnabled
          && report.packetsSent >= minimumTimingPackets
          && report.packetsReceived >= minimumTimingPackets
          && report.relayEchoes > 0;
        if (!routeMeasured) return;
        // AudioService's p99 arrival requirement is measured from musical timestamps and actual
        // packet arrival, independently of the server-selected room deadline. RTT/2 misses
        // asymmetric and recurring return-path stalls, so it is only a fallback before that
        // measured requirement is available.
        const independentLatency = report.requestedVoiceDelayMs ?? report.estimatedVoiceLatencyMs;
        const latency = Math.round(Math.max(0, Math.min(500,
          independentLatency)) * 10) / 10;
        // The route's return and arrival stages are published once AudioService has calibrated
        // both; until then the server keeps its previous deadline and says so in its diagnostics.
        const stages = routeStagesOf(report);
        const stagesMoved = stages !== undefined && (lastStagesPublished === undefined
          || Math.abs(stages.returnRequirementMs - lastStagesPublished.returnRequirementMs) >= 1
          || Math.abs(stages.arrivalRequirementMs - lastStagesPublished.arrivalRequirementMs) >= 1);
        if (Math.abs(latency - lastPublished) < 1 && !stagesMoved) return;
        const updated = await roomClient.setVoiceLatency(code, latency, stages);
        if (!active) return;
        // Apply the deadline returned by this very request. Waiting for the room change poll
        // leaves AudioService on the previous deadline while the UI already shows the new one.
        await audioClient.setRoomPlayoutDelay(updated.roomPlayoutDelayMs ?? 10);
        if (!active) return;
        lastPublished = latency;
        lastStagesPublished = stages;
        roomRef.current = updated;
        setRoom(updated);
      } catch {
        // A later sample retries; room playback remains available with the last stable estimate.
      } finally {
        publishing = false;
      }
    };
    void publishTiming();
    const timer = window.setInterval(() => void publishTiming(), timingPollMilliseconds);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [code, setRoom]);
};
