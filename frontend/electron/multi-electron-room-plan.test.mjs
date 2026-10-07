import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBackendSwitchAudioPath,
  analyzeRoomAudioGaps,
  maximumActiveLateCutDelta,
  personalControlReturnReady,
  phaseAtSecond,
  relayProbePacket,
  roomE2eEndpoint,
  roomE2eLiveDelay,
  roomE2eScenario,
  roomE2eTransportOnly,
  toneContinuity,
  toneLevel,
  validateNegotiation,
} from "./multi-electron-room-plan.mjs";

test("personal-control PCM sampling waits for audible remote return", () => {
  assert.equal(personalControlReturnReady({ SessionState: "Running",
    RemoteMixPeak: "0", MasterOutputPeak: "0" }), false);
  assert.equal(personalControlReturnReady({ SessionState: "Failed",
    RemoteMixPeak: "0.1", MasterOutputPeak: "0.1" }), false);
  assert.equal(personalControlReturnReady({ SessionState: "Running",
    RemoteMixPeak: "0.1", MasterOutputPeak: "0.1" }), true);
});

test("the 60-second room scenario exercises both directions, simultaneous singing, and reconnect", () => {
  assert.deepEqual([5, 15, 25, 30, 40, 50, 58].map(phaseAtSecond), [
    "A_TO_B",
    "B_TO_A",
    "BOTH",
    "RECONNECT_B",
    "A_TO_B",
    "B_TO_A",
    "BOTH",
  ]);
});

test("production negotiation rejects the historic 160-to-10ms fallback", () => {
  assert.throws(
    () =>
      validateNegotiation({
        publishedA: 160,
        publishedB: 160,
        selected: 10,
        appliedA: 10,
        appliedB: 10,
      }),
    /unsafe.*10 ms/i,
  );
  assert.doesNotThrow(() =>
    validateNegotiation({
      publishedA: 160,
      publishedB: 160,
      selected: 80,
      appliedA: 80,
      appliedB: 80,
    }),
  );
});

test("final PCM continuity survives a short phase discontinuity but exposes sustained silence", () => {
  const rate = 48_000,
    frequency = 697;
  const samples = Float64Array.from({ length: rate }, (_, frame) => {
    const phase = frame >= rate / 2 ? Math.PI : 0;
    return Math.sin((2 * Math.PI * frequency * frame) / rate + phase);
  });
  assert.ok(toneContinuity(samples, rate, frequency, 0, 1) > 0.95);

  samples.fill(0, Math.floor(rate * 0.3), Math.floor(rate * 0.7));
  assert.ok(toneContinuity(samples, rate, frequency, 0, 1) < 0.7);
});

test("final PCM tone level measures personal volume attenuation", () => {
  const rate = 48_000,
    frequency = 941;
  const samples = Float64Array.from({ length: rate * 2 }, (_, frame) => {
    const gain = frame < rate ? 0.8 : 0.2;
    return gain * Math.sin((2 * Math.PI * frequency * frame) / rate);
  });
  const loud = toneLevel(samples, rate, frequency, 0, 1);
  const quiet = toneLevel(samples, rate, frequency, 1, 2);
  assert.ok(loud > 0.79 && loud < 0.81);
  assert.ok(quiet > 0.19 && quiet < 0.21);
});

for (const { name, packetFrames, offset } of [
  { name: "100-ms phase resets", packetFrames: 4_800, offset: 0 },
  { name: "off-grid 120-frame phase resets", packetFrames: 120, offset: 0.011 },
]) {
  test(`final PCM level survives ${name}`, () => {
    const rate = 48_000,
      frequency = 941;
    const samples = Float64Array.from({ length: rate * 3 }, (_, frame) => {
      const gain = frame < rate ? 0.8 : frame < rate * 2 ? 0.2 : 0;
      const phase = Math.floor(frame / packetFrames) % 2 ? Math.PI : 0;
      return gain * Math.sin((2 * Math.PI * frequency * frame) / rate + phase);
    });
    const level = (second) =>
      toneLevel(samples, rate, frequency, second + offset, second + 1 - offset);
    const loud = level(0),
      quiet = level(1);

    assert.ok(loud > 0.79 && loud < 0.81);
    assert.ok(quiet > 0.19 && quiet < 0.21);
    assert.equal(level(2), 0);
  });
}

test("isolated PCM level follows gain when the received tone shifts frequency", () => {
  const rate = 48_000,
    gains = [0.8, 0.2, 0.96, 0];
  const samples = Float64Array.from({ length: rate * 4 }, (_, frame) => {
    const second = Math.floor(frame / rate);
    const gain = gains[second];
    const frequency = second < 2 ? 919 : 941;
    return gain * Math.sin((2 * Math.PI * frequency * frame) / rate);
  });

  const baseline = toneLevel(samples, rate, 941, 0.011, 0.989);
  const quiet = toneLevel(samples, rate, 941, 1.011, 1.989);
  const restored = toneLevel(samples, rate, 941, 2.011, 2.989);
  assert.ok(quiet / restored > 0.18 && quiet / restored < 0.24);
  assert.ok(baseline > 0.79 && baseline < 0.81);
  assert.ok(quiet > 0.19 && quiet < 0.21);
  assert.ok(restored > 0.95 && restored < 0.97);
  assert.equal(toneLevel(samples, rate, 941, 3.011, 3.989), 0);
});

test("final PCM tone presence rejects other frequencies", () => {
  const rate = 48_000,
    target = 941,
    other = 697;
  const samples = Float64Array.from({ length: rate * 2 }, (_, frame) => {
    const frequency = frame < rate ? other : target;
    return 0.8 * Math.sin((2 * Math.PI * frequency * frame) / rate);
  });

  assert.ok(toneContinuity(samples, rate, target, 0.011, 0.989) < 0.1);
  assert.ok(toneContinuity(samples, rate, target, 1.011, 1.989) > 0.95);
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
  assert.equal(
    maximumActiveLateCutDelta(samples, (item) => item.cuts),
    4,
  );
  samples.push({ phase: "BOTH", cuts: 230 });
  assert.equal(
    maximumActiveLateCutDelta(samples, (item) => item.cuts),
    19,
  );
});

test("soak scenarios are explicit and keep steady and seek results separate", () => {
  assert.deepEqual(roomE2eScenario(["--scenario=steady", "--duration=180"]), {
    name: "steady",
    durationSeconds: 180,
  });
  assert.deepEqual(roomE2eScenario(["--scenario=seek", "--duration=240"]), {
    name: "seek",
    durationSeconds: 240,
  });
  assert.throws(
    () => roomE2eScenario(["--scenario=seek", "--duration=60"]),
    /at least 180/i,
  );
});

test("the production-path E2E can target an explicit external Room Server", () => {
  assert.deepEqual(
    roomE2eEndpoint([
      "--room-server=http://130.61.169.61:8081",
      "--relay-port=40000",
    ]),
    {
      external: true,
      apiBase: "http://130.61.169.61:8081",
      host: "130.61.169.61",
      httpPort: 8081,
      relayPort: 40000,
    },
  );
  assert.deepEqual(roomE2eEndpoint([]), { external: false });
  assert.throws(
    () => roomE2eEndpoint(["--room-server=http://130.61.169.61:8081"]),
    /relay port/i,
  );
});

test("transport-only mode isolates relay cadence from the independent participant-control gate", () => {
  assert.equal(roomE2eTransportOnly(["--transport-only"]), true);
  assert.equal(roomE2eTransportOnly([]), false);
});

test("pipeline analyzer classifies every large gap and correlates client send and receive stalls", () => {
  const serverEntries = [
    {
      participantId: "A",
      values: {
        ServerGapNetworkOrIngressStall: "3",
        ServerGapEventLoopStall: "4",
        ServerPipelinePosition: "12000",
        ServerSendGapMaximumMs: "30",
      },
    },
  ];
  const clientSamples = [
    {
      A: {
        NetworkSendGapMaximumMs: "50",
        NetworkSendGapMaximumTimelineFrame: "12000",
        NetworkSendGapMaximumSessionGeneration: "7",
        NetworkSendGapMaximumStreamEpoch: "3",
        "RemoteSocketReceiveGapMaximumUs.__room_server_mix__": "80000",
        ServerSendGapMaximumMs: "30",
      },
    },
  ];
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

test("backend-switch analyzer identifies the first PCM stage that is silent before recreation", () => {
  const sender = { RoomVoiceUpstreamPeak: "0.2" };
  const before = {
    "App.RequestedBackend": "ASIO",
    "App.PersistedBackend": "ASIO",
    Backend: "WASAPI Shared",
    ActiveOutputDeviceId: "default-speakers",
    generationId: "7",
    ServerIngressPeakPcm16: "6000",
    ServerRecipientPeakPcm16: "5800",
    "RemoteDecodedPeak.__room_server_mix__": "0",
    "RemoteQueuedPeak.__room_server_mix__": "0",
    "RemoteRenderedPeak.__room_server_mix__": "0",
    RemoteMixPeak: "0",
    MasterOutputPeak: "0",
    BackendOutputPeak: "0",
  };
  const after = {
    ...before,
    Backend: "ASIO",
    ActiveOutputDeviceId: "asio-driver",
    generationId: "9",
    "RemoteDecodedPeak.__room_server_mix__": "0.18",
    "RemoteQueuedPeak.__room_server_mix__": "0.18",
    "RemoteRenderedPeak.__room_server_mix__": "0.17",
    RemoteMixPeak: "0.17",
    MasterOutputPeak: "0.16",
    BackendOutputPeak: "0.16",
  };

  assert.deepEqual(analyzeBackendSwitchAudioPath({ sender, before, after }), {
    requestedActualMismatchBefore: true,
    beforeBackend: "WASAPI Shared",
    afterBackend: "ASIO",
    beforeGeneration: "7",
    afterGeneration: "9",
    firstSilentBefore: "CLIENT_DECODE",
    firstSilentAfter: null,
  });
});

test("public relay probe uses the production 120-frame shared-timeline PCM packet", () => {
  const bytes = relayProbePacket(7, 0x11223344, 0x55667788n);

  assert.equal(bytes.length, 44 + 120 * 2);
  assert.equal(bytes.readUInt8(32), 1);
  assert.equal(bytes.readUInt8(33), 1);
  assert.equal(bytes.readUInt16LE(34), 120);
  assert.equal(bytes.readUInt32LE(36), 0);
  assert.equal(bytes.readBigUInt64LE(24), (1n << 63n) | 840n);
});
