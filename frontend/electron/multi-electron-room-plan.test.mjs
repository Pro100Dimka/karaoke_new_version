import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRoomAudioGaps, maximumActiveLateCutDelta, phaseAtSecond, roomE2eLiveDelay, roomE2eScenario, toneContinuity, toneLevel, validateNegotiation } from "./multi-electron-room-plan.mjs";

test("the 60-second room scenario exercises both directions, simultaneous singing, and reconnect", () => {
  assert.deepEqual([5, 15, 25, 30, 40, 50, 58].map(phaseAtSecond), [
    "A_TO_B", "B_TO_A", "BOTH", "RECONNECT_B", "A_TO_B", "B_TO_A", "BOTH",
  ]);
});

test("production negotiation rejects the historic 160-to-10ms fallback", () => {
  assert.throws(() => validateNegotiation({
    publishedA: 160, publishedB: 160, selected: 10, appliedA: 10, appliedB: 10,
  }), /unsafe.*10 ms/i);
  assert.doesNotThrow(() => validateNegotiation({
    publishedA: 160, publishedB: 160, selected: 80, appliedA: 80, appliedB: 80,
  }));
});

test("final PCM continuity survives a short phase discontinuity but exposes sustained silence", () => {
  const rate = 48_000, frequency = 697;
  const samples = Float64Array.from({ length: rate }, (_, frame) => {
    const phase = frame >= rate / 2 ? Math.PI : 0;
    return Math.sin(2 * Math.PI * frequency * frame / rate + phase);
  });
  assert.ok(toneContinuity(samples, rate, frequency, 0, 1) > 0.95);

  samples.fill(0, Math.floor(rate * 0.3), Math.floor(rate * 0.7));
  assert.ok(toneContinuity(samples, rate, frequency, 0, 1) < 0.7);
});

test("final PCM tone level measures personal volume attenuation", () => {
  const rate = 48_000, frequency = 941;
  const samples = Float64Array.from({ length: rate * 2 }, (_, frame) => {
    const gain = frame < rate ? 0.8 : 0.2;
    return gain * Math.sin(2 * Math.PI * frequency * frame / rate);
  });
  const loud = toneLevel(samples, rate, frequency, 0, 1);
  const quiet = toneLevel(samples, rate, frequency, 1, 2);
  assert.ok(loud > 0.79 && loud < 0.81);
  assert.ok(quiet > 0.19 && quiet < 0.21);
});

test("the production room test accepts only a safe explicit live deadline", () => {
  assert.equal(roomE2eLiveDelay(["--live-delay=45"]), 45);
  assert.equal(roomE2eLiveDelay([]), 80);
  assert.throws(() => roomE2eLiveDelay(["--live-delay=9"]), /live delay/i);
  assert.throws(() => roomE2eLiveDelay(["--live-delay=81"]), /live delay/i);
});

test("reconnect recovery cuts are reported without hiding cuts during active singing", () => {
  const samples = [
    { phase: "A_TO_B", cuts: 2 },
    { phase: "A_TO_B", cuts: 5 },
    { phase: "RECONNECT_B", cuts: 105 },
    { phase: "RECOVERY", cuts: 205 },
    { phase: "A_TO_B", cuts: 207 },
    { phase: "A_TO_B", cuts: 211 },
  ];
  assert.equal(maximumActiveLateCutDelta(samples, item => item.cuts), 4);
  samples.push({ phase: "BOTH", cuts: 230 });
  assert.equal(maximumActiveLateCutDelta(samples, item => item.cuts), 19);
});

test("soak scenarios are explicit and keep steady and seek results separate", () => {
  assert.deepEqual(roomE2eScenario(["--scenario=steady", "--duration=180"]), {
    name: "steady", durationSeconds: 180,
  });
  assert.deepEqual(roomE2eScenario(["--scenario=seek", "--duration=240"]), {
    name: "seek", durationSeconds: 240,
  });
  assert.throws(() => roomE2eScenario(["--scenario=seek", "--duration=60"]), /at least 180/i);
});

test("pipeline analyzer classifies every large gap and correlates client send and receive stalls", () => {
  const serverEntries = [{ participantId: "A", values: {
    ServerGapNetworkOrIngressStall: "3",
    ServerGapEventLoopStall: "4",
    ServerPipelinePosition: "12000",
    ServerSendGapMaximumMs: "30",
  } }];
  const clientSamples = [{ A: {
    NetworkSendGapMaximumMs: "50",
    NetworkSendGapMaximumTimelineFrame: "12000",
    NetworkSendGapMaximumSessionGeneration: "7",
    NetworkSendGapMaximumStreamEpoch: "3",
    "RemoteSocketReceiveGapMaximumUs.__room_server_mix__": "80000",
    ServerSendGapMaximumMs: "30",
  } }];
  assert.deepEqual(analyzeRoomAudioGaps(serverEntries, clientSamples), {
    total: 8,
    distribution: {
      CLIENT_SEND_STALL: 1,
      NETWORK_OR_INGRESS_STALL: 2,
      POSITION_COLLECTION_STALL: 0,
      MIX_BUILD_STALL: 0,
      SENDTO_STALL: 0,
      SERVER_EVENT_LOOP_STALL: 4,
      CLIENT_RECEIVE_STALL: 1,
      SEEK_LIFECYCLE_STALL: 0,
      UNKNOWN: 0,
    },
  });
});
