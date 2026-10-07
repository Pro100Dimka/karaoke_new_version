export const phaseAtSecond = (second) => {
  if (second === 30) return "RECONNECT_B";
  if (second < 10 || (second >= 35 && second < 45)) return "A_TO_B";
  if ((second >= 10 && second < 20) || (second >= 45 && second < 55))
    return "B_TO_A";
  if ((second >= 20 && second < 30) || second >= 55) return "BOTH";
  return "RECOVERY";
};

export const validateNegotiation = ({
  publishedA,
  publishedB,
  selected,
  appliedA,
  appliedB,
}) => {
  if (publishedA >= 80 && publishedB >= 80 && selected <= 10)
    throw new Error(
      `Unsafe production deadline fallback selected ${selected} ms`,
    );
  if (
    ![selected, appliedA, appliedB].every(Number.isFinite) ||
    Math.abs(appliedA - selected) > 1 ||
    Math.abs(appliedB - selected) > 1
  )
    throw new Error(
      `Room deadline was not applied consistently: ${selected}/${appliedA}/${appliedB}`,
    );
};

export const toneState = (phase) =>
  ({
    A_TO_B: [0.1, 0],
    B_TO_A: [0, 0.1],
    BOTH: [0.1, 0.1],
    RECONNECT_B: [0, 0],
    RECOVERY: [0, 0],
  })[phase];

export const personalControlReturnReady = (diagnostics) =>
  diagnostics.SessionState === "Running" &&
  Number(diagnostics.RemoteMixPeak ?? 0) > 0.02 &&
  Number(diagnostics.MasterOutputPeak ?? 0) > 0.02;

export const roomE2eLiveDelay = (args) => {
  const option = args.find((value) => value.startsWith("--live-delay="));
  if (!option) return 80;
  const value = Number(option.slice("--live-delay=".length));
  if (!Number.isFinite(value) || value < 10 || value > 80)
    throw new Error(
      `Live delay must be between 10 and 80 ms, received ${option}`,
    );
  return value;
};

export const roomE2eTransportOnly = (args) => args.includes("--transport-only");

export const roomE2eEndpoint = (args) => {
  const option = args.find((value) => value.startsWith("--room-server="));
  if (!option) return { external: false };
  const url = new URL(option.slice("--room-server=".length));
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
    throw new Error(`Invalid Room Server endpoint: ${option}`);
  const relayOption = args.find((value) => value.startsWith("--relay-port="));
  const relayPort = Number(relayOption?.slice("--relay-port=".length));
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65_535)
    throw new Error("An external Room Server requires a valid relay port");
  return {
    external: true,
    apiBase: url.origin,
    host: url.hostname,
    httpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    relayPort,
  };
};

export const roomE2eScenario = (args) => {
  const name =
    args
      .find((value) => value.startsWith("--scenario="))
      ?.slice("--scenario=".length) ?? "standard";
  const durationOption = args.find((value) => value.startsWith("--duration="));
  const durationSeconds = durationOption
    ? Number(durationOption.slice("--duration=".length))
    : name === "standard"
      ? 60
      : 180;
  if (!["standard", "steady", "seek"].includes(name))
    throw new Error(`Unknown room E2E scenario: ${name}`);
  if (
    !Number.isInteger(durationSeconds) ||
    durationSeconds < (name === "standard" ? 60 : 180)
  )
    throw new Error(
      `${name} room E2E duration must be at least ${name === "standard" ? 60 : 180} seconds`,
    );
  return { name, durationSeconds };
};

export const ROOM_GAP_REASONS = [
  "CLIENT_SEND_STALL",
  "NETWORK_OR_INGRESS_STALL",
  "POSITION_COLLECTION_STALL",
  "MIX_BUILD_STALL",
  "SENDTO_STALL",
  "SERVER_EVENT_LOOP_STALL",
  "CLIENT_RECEIVE_STALL",
  "SEEK_LIFECYCLE_STALL",
  "UNKNOWN",
];

export const relayProbePacket = (sequence, participantKey, token) => {
  const frames = 120,
    bytes = Buffer.alloc(44 + frames * 2);
  bytes.writeUInt32LE(0x32445541, 0);
  bytes.writeUInt16LE(3, 4);
  bytes.writeUInt16LE(44, 6);
  bytes.writeUInt32LE(sequence, 8);
  bytes.writeUInt32LE(participantKey, 12);
  bytes.writeBigUInt64LE(token, 16);
  bytes.writeBigUInt64LE((1n << 63n) | BigInt(sequence * frames), 24);
  bytes.writeUInt8(1, 32);
  bytes.writeUInt8(1, 33);
  bytes.writeUInt16LE(frames, 34);
  bytes.writeUInt32LE(0, 36);
  bytes.writeUInt32LE(1, 40);
  return bytes;
};

const diagnosticNumber = (value) => Number(value ?? 0) || 0;

const backendSwitchStages = [
  ["SENDER_NORMALIZATION", (sender, _receiver) => sender.RoomVoiceUpstreamPeak],
  ["SERVER_INGRESS", (_sender, receiver) => receiver.ServerIngressPeakPcm16],
  ["RECIPIENT_MIX", (_sender, receiver) => receiver.ServerRecipientPeakPcm16],
  [
    "CLIENT_DECODE",
    (_sender, receiver) => receiver["RemoteDecodedPeak.__room_server_mix__"],
  ],
  [
    "REMOTE_QUEUE",
    (_sender, receiver) => receiver["RemoteQueuedPeak.__room_server_mix__"],
  ],
  [
    "REMOTE_RENDER",
    (_sender, receiver) => receiver["RemoteRenderedPeak.__room_server_mix__"],
  ],
  ["MASTER_MIX", (_sender, receiver) => receiver.MasterOutputPeak],
  ["BACKEND_OUTPUT", (_sender, receiver) => receiver.BackendOutputPeak],
];

/** Locates the first silent production stage around one physical backend recreation. */
export const analyzeBackendSwitchAudioPath = ({ sender, before, after }) => {
  const firstSilent = (receiver) =>
    backendSwitchStages.find(
      ([, value]) => !(diagnosticNumber(value(sender, receiver)) > 0),
    )?.[0] ?? null;
  return {
    requestedActualMismatchBefore: Boolean(
      before["App.RequestedBackend"] &&
      before.Backend &&
      before["App.RequestedBackend"] !== before.Backend,
    ),
    beforeBackend: before.Backend ?? "unknown",
    afterBackend: after.Backend ?? "unknown",
    beforeGeneration: before.generationId ?? "unknown",
    afterGeneration: after.generationId ?? "unknown",
    firstSilentBefore: firstSilent(before),
    firstSilentAfter: firstSilent(after),
  };
};

export const analyzeRoomAudioGaps = (serverEntries, clientSamples) => {
  const distribution = Object.fromEntries(
    ROOM_GAP_REASONS.map((reason) => [reason, 0]),
  );
  const serverKey = {
    CLIENT_SEND_STALL: "ServerGapClientSendStall",
    NETWORK_OR_INGRESS_STALL: "ServerGapNetworkOrIngressStall",
    POSITION_COLLECTION_STALL: "ServerGapPositionCollectionStall",
    MIX_BUILD_STALL: "ServerGapMixBuildStall",
    SENDTO_STALL: "ServerGapSendtoStall",
    SERVER_EVENT_LOOP_STALL: "ServerGapEventLoopStall",
    SEEK_LIFECYCLE_STALL: "ServerGapSeekLifecycleStall",
    UNKNOWN: "ServerGapUnknown",
  };
  for (const [reason, key] of Object.entries(serverKey))
    distribution[reason] = Math.max(
      0,
      ...serverEntries.map((entry) => diagnosticNumber(entry.values?.[key])),
    );

  // A physical client send stall is initially visible to the server as an ingress stall. Use the
  // common absolute room frame to refine that category without double-counting the same event.
  const latestServer = serverEntries.at(-1)?.values ?? {};
  const pipelineFrame = diagnosticNumber(latestServer.ServerPipelinePosition);
  const sides = ["A", "B"];
  for (const side of sides) {
    const values = clientSamples.at(-1)?.[side] ?? {};
    const sendGap = diagnosticNumber(values.NetworkSendGapMaximumMs);
    const sendFrame = diagnosticNumber(
      values.NetworkSendGapMaximumTimelineFrame,
    );
    if (
      sendGap > 20 &&
      pipelineFrame &&
      Math.abs(sendFrame - pipelineFrame) <= 240 &&
      distribution.NETWORK_OR_INGRESS_STALL > 0
    ) {
      distribution.NETWORK_OR_INGRESS_STALL--;
      distribution.CLIENT_SEND_STALL++;
    }
    const receiveGapMs =
      diagnosticNumber(
        values["RemoteSocketReceiveGapMaximumUs.__room_server_mix__"],
      ) / 1000;
    const serverSendGapMs = diagnosticNumber(
      values.ServerSendGapMaximumMs ?? latestServer.ServerSendGapMaximumMs,
    );
    if (receiveGapMs > 20 && receiveGapMs > serverSendGapMs + 5)
      distribution.CLIENT_RECEIVE_STALL++;
  }
  return {
    total: Object.values(distribution).reduce((sum, count) => sum + count, 0),
    distribution,
  };
};

const activeSingingPhases = new Set(["A_TO_B", "B_TO_A", "BOTH"]);

export const maximumActiveLateCutDelta = (samples, valueOf) => {
  let previous,
    maximum = 0;
  for (const sample of samples) {
    if (!activeSingingPhases.has(sample.phase)) {
      previous = undefined;
      continue;
    }
    const current = valueOf(sample);
    if (previous !== undefined) maximum = Math.max(maximum, current - previous);
    previous = current;
  }
  return maximum;
};

const toneMeasurements = (
  samples,
  rate,
  frequency,
  fromSecond,
  toSecond,
) => {
  const first = Math.max(0, Math.floor(fromSecond * rate));
  const last = Math.min(samples.length, Math.floor(toSecond * rate));
  const windowFrames = Math.max(1, Math.round(rate * 0.02));
  let present = 0,
    windows = 0,
    level = 0;
  for (let start = first; start + windowFrames <= last; start += windowFrames) {
    let sin = 0,
      cos = 0,
      total = 0;
    for (let index = start; index < start + windowFrames; index++) {
      const value = samples[index],
        phase = (2 * Math.PI * frequency * index) / rate;
      sin += value * Math.sin(phase);
      cos += value * Math.cos(phase);
      total += value * value;
    }
    const tone = (2 * (sin * sin + cos * cos)) / windowFrames;
    if (tone / Math.max(1e-12, total) >= 0.08) present++;
    level += Math.sqrt((2 * total) / windowFrames);
    windows++;
  }
  return {
    continuity: windows === 0 ? 0 : present / windows,
    level: windows === 0 ? 0 : level / windows,
  };
};

export const toneContinuity = (samples, rate, frequency, fromSecond, toSecond) =>
  toneMeasurements(samples, rate, frequency, fromSecond, toSecond).continuity;

/** Level of the isolated personal-controls PCM (host tone and song are silent). */
export const toneLevel = (samples, rate, frequency, fromSecond, toSecond) =>
  toneMeasurements(samples, rate, frequency, fromSecond, toSecond).level;
