// End-to-end room voice timing probe on one Windows machine with real audio devices.
//
// Client A is a "perfect singer": it plays the song on a device whose loopback capture endpoint is
// its microphone, so A sings exactly what it hears, exactly when it hears it. Client B plays the same
// song and records what it renders. In B's recording the delay between B's own backing track and the
// copy that arrives as A's "voice" is the lag a real listener hears between the music and a remote
// singer. A's own recording shows how far a local voice sits from the music in a saved performance.
//
// Usage: node room-sync-probe.mjs <out-dir> [--seconds 20] [--relay-only] [--backend wasapi-shared] [--follow]
// Device ids are taken from AD_VOICE_PROBE_* variables or detected by endpoint name.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = process.env.AD_VOICE_AUDIO_SERVICE
  ?? path.join(root, "AudioService", "build", "Release", "AudioService.exe");
const serverApi = process.env.AD_VOICE_ROOM_SERVER_API ?? "http://130.61.169.61:8081";
const relayHost = process.env.AD_VOICE_ROOM_SERVER_HOST ?? "130.61.169.61";
const relayPort = Number(process.env.AD_VOICE_ROOM_SERVER_RELAY_PORT ?? 40000);
const args = process.argv.slice(2);
const outDir = path.resolve(args[0] ?? "room-sync-probe");
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const seconds = Number(option("--seconds", "20"));
const backend = option("--backend", "wasapi-shared");
const relayOnly = args.includes("--relay-only");
const songDir = option("--song", path.join(process.env.APPDATA, "AD Voice", "backend-data", "songs",
  "d9711830-2e88-4b70-85e1-1b671d73614d", "revisions", "2", "audio"));
const startSeconds = Number(option("--start", "30"));
mkdirSync(outDir, { recursive: true });

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const suffix = crypto.randomUUID().slice(0, 8);
const clients = ["A", "B"].map(name => ({
  name,
  participantId: `sync-probe-${suffix}-${name}`,
  pipe: `ADVoice.SyncProbe.${suffix}.${name}`,
}));
const processes = clients.map(client => spawn(executable, [], {
  env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: "\\\\.\\pipe\\" + client.pipe },
  windowsHide: true,
  stdio: "ignore",
}));

const once = (pipe, line) => new Promise((resolve, reject) => {
  const socket = net.createConnection("\\\\.\\pipe\\" + pipe);
  let text = "";
  socket.once("connect", () => socket.write(`${line}\n`));
  socket.on("data", chunk => { text += chunk.toString("utf8"); });
  socket.once("close", () => resolve(text));
  socket.once("error", reject);
});
const audio = async (client, command, values = {}) => {
  const line = ["1", command, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join("|");
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = await once(client.pipe, line);
      if (!text.startsWith("0|")) throw new Error(`${client.name} ${command} failed: ${text.trim()}`);
      return text.slice(2);
    } catch (error) {
      if (attempt > 60 || String(error.message).includes("failed:")) throw error;
      await delay(100);
    }
  }
};
const request = async (method, route, body) => {
  const response = await fetch(`${serverApi}${route}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} failed (${response.status}): ${await response.text()}`);
  return response.status === 204 ? null : response.json();
};
const parse = text => Object.fromEntries(text.split(/\r?\n/)
  .map(line => /^([A-Za-z0-9_.-]+): (.*)$/.exec(line)).filter(Boolean).map(match => [match[1], match[2]]));
const deviceId = (devicesText, kind, pattern) => {
  const wanted = kind === "input" ? "1" : "0";
  const line = devicesText.split(/\r?\n/).find(item => {
    const [id, name] = item.split(",");
    return id?.startsWith(`{0.0.${wanted}.`) && pattern.test(name ?? "");
  });
  if (!line) throw new Error(`No ${kind} device matches ${pattern}`);
  return line.split(",")[0];
};

let roomId = "";
const report = { startedAt: new Date().toISOString(), backend, relayOnly, seconds };
try {
  const devices = await audio(clients[0], "GetDevices");
  const devicesFor = {
    A: {
      // "--acoustic": a speaker is held against the microphone, so the real analogue input hears A.
      input: process.env.AD_VOICE_PROBE_A_INPUT
        ?? deviceId(devices, "input", args.includes("--acoustic") ? /^Analogue 1\/2/ : /Loop-back 1\/2/),
      output: process.env.AD_VOICE_PROBE_A_OUTPUT ?? deviceId(devices, "output", /Analogue 1\/2/),
    },
    B: {
      input: process.env.AD_VOICE_PROBE_B_INPUT ?? deviceId(devices, "input", /Steam Streaming Microphone/),
      output: process.env.AD_VOICE_PROBE_B_OUTPUT ?? deviceId(devices, "output", /Steam Streaming Speakers/),
    },
  };
  report.devices = devicesFor;

  const room = await request("POST", "/rooms", { participantId: clients[0].participantId, displayName: "Probe A" });
  roomId = room.roomId;
  await request("POST", `/rooms/${roomId}/join`, { participantId: clients[1].participantId, displayName: "Probe B" });
  const tokens = await Promise.all(clients.map(client =>
    request("POST", "/voice/join", { roomId, participantId: client.participantId }).then(value => value.voiceToken)));

  for (const client of clients) {
    const device = devicesFor[client.name];
    const clientBackend = option(`--backend-${client.name.toLowerCase()}`, backend);
    // An ASIO driver owns its own channels; endpoint ids of the Windows audio stack do not apply.
    const endpoints = clientBackend === "asio" ? { input: "", output: "" } : device;
    await audio(client, "Reconfigure", { backend: clientBackend, input: endpoints.input, output: endpoints.output,
      rate: 0, period: 0, inChannels: 0, outChannels: 0 });
    await audio(client, "StartSession").catch(() => undefined);
  }
  // Both processes share the machine's steady clock, so one mapping gives them an exact common room clock.
  const clockNow = Number(parse(await audio(clients[0], "GetDiagnostics")).MonotonicTicks) / 1000;
  for (const client of clients) {
    await audio(client, "SetRoomClock", { serverMicros: Math.round(clockNow), localMicros: Math.round(clockNow) });
  }
  const ports = [];
  for (const [index, client] of clients.entries()) {
    await audio(client, "AddRemoteParticipant", { participantId: clients[1 - index].participantId });
    const joined = await audio(client, "JoinMediaSession", {
      localParticipantId: client.participantId, localPort: 0, host: relayHost, remotePort: relayPort,
      voiceToken: tokens[index],
    });
    ports.push(Number(/localPort=(\d+)/.exec(joined)?.[1] ?? 0));
  }
  if (!relayOnly) {
    for (const [index, client] of clients.entries()) {
      await audio(client, "SetDirectPeer", { participantId: clients[1 - index].participantId,
        host: "127.0.0.1", port: ports[1 - index], voiceToken: tokens[1 - index] });
    }
  }
  // The captured copy is kept well below each client's own music so the analyser cannot mistake one
  // for the other. A also plays the reference vocal as its guide. The saved performance never contains the guide, so
  // the vocal can reach any recording only through A's captured "voice": its position marks the copy.
  const instrumental = path.join(songDir, "instrumental.wav");
  const vocals = path.join(songDir, "reference-vocal.wav");
  for (const client of clients) {
    const acoustic = args.includes("--acoustic");
    const isA = client.name === "A";
    // Everything plays quietly (people may be asleep); the microphone gain makes up the level. The
    // acoustic path (speaker held to the microphone) is ~30 dB below the digital loopback.
    const levels = {
      music: isA ? 0.15 : 0.3,
      reference: isA ? (acoustic ? 0.5 : 0.3) : 0,
      mic: acoustic ? Number(option("--mic-gain", "30")) : 1,
      remote: 0.3,
    };
    await audio(client, "SetMonitoring", { enabled: false });
    await audio(client, "SetDspEnabled", { enabled: false });
    for (const [target, value] of [...Object.entries(levels), ["melody", 0], ["master", 1]])
      await audio(client, "SetGain", { target, value });
    await audio(client, "LoadSong", { instrumental, vocals });
    // "--follow": B plays the song one room delay later so A's voice lands on B's beat.
    const following = client.name === "B" && args.includes("--follow");
    await audio(client, "SetRoomFollow", { participantId: following ? clients[0].participantId : "" });
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const states = await Promise.all(clients.map(async client => parse(await audio(client, "GetDiagnostics")).PlaybackState));
    if (states.every(state => state === "Ready" || state === "Paused" || state === "Stopped")) break;
    await delay(100);
  }
  if (args.includes("--calibrate")) {
    // A measures the round trip its devices do not report (speaker held to the microphone).
    const results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await audio(clients[0], "MeasureAcousticLatency");
      for (let wait = 0; wait < 60; wait += 1) {
        await delay(100);
        const state = await audio(clients[0], "GetAcousticLatency");
        if (/state=(Done|Failed)/.test(state)) { results.push(state.trim()); break; }
      }
    }
    report.acousticLatency = results;
    const values = results.map(line => Number(/ms=([0-9.]+)/.exec(line)?.[1])).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length) {
      report.appliedAcousticLatencyMs = values[Math.floor(values.length / 2)];
      await audio(clients[0], "SetAcousticLatency", { ms: report.appliedAcousticLatencyMs });
    }
    console.log(JSON.stringify({ acousticLatency: results, applied: report.appliedAcousticLatencyMs }));
  }
  // Let the voice path warm up (route, jitter and common target) before the song starts, as in a room.
  await delay(4000);
  for (const client of clients) {
    await audio(client, "PrepareRecording", { id: `${client.name}-${suffix}`,
      path: path.join(outDir, `${client.name}.wav`),
      // "--heard": B records what it plays (the live experience) instead of the aligned performance.
      tap: client.name === "B" && args.includes("--heard") ? "master" : "performance" });
  }
  const rate = Number(parse(await audio(clients[0], "GetDiagnostics")).RuntimeOutputSampleRate) || 48000;
  const startAtTicks = Number(parse(await audio(clients[0], "GetDiagnostics")).MonotonicTicks) + 2_000_000_000;
  const frame = Math.round(startSeconds * rate);
  for (const client of clients) {
    await audio(client, "Play", { context: "karaoke", startAtTicks, frame });
    await audio(client, "StartRecording");
  }
  const samples = [];
  const until = Date.now() + seconds * 1000 + 2000;
  while (Date.now() < until) {
    await delay(1000);
    samples.push(await Promise.all(clients.map(async client => {
      const values = parse(await audio(client, "GetDiagnostics"));
      const remote = clients.find(other => other !== client).participantId;
      const pick = key => values[key];
      return {
        client: client.name,
        backend: pick("Backend"),
        roomCompensationFrames: Number(pick("RoomCompensationFrames")),
        roundTripMs: Number(pick("NetworkRoundTripMs")),
        directPeers: Number(pick("NetworkDirectPeerCount")),
        outputLatencyFrames: Number(pick("OutputDriverLatencyFrames")),
        captureLatencyFrames: Number(pick("CaptureLatencyFrames")),
        clockBridgeFrames: Number(pick("ClockBridgeLatencyFrames")),
        remoteClockOffsetMs: Number(pick(`RemoteClockOffsetMs.${remote}`)),
        remoteJitterMs: Number(pick(`RemoteJitterMs.${remote}`)),
        remoteTargetDelayFrames: Number(pick(`RemoteTargetDelayFrames.${remote}`)),
        remoteLatePackets: Number(pick(`RemoteLatePackets.${remote}`)),
        receiveQueueFill: Number(pick("NetworkReceiveQueueFill")),
        inputRms: Number(pick("InputRMS")),
        latenessTargetFrames: Number(pick(`RemoteLatenessTargetFrames.${remote}`)),
        lateAudioCuts: Number(pick(`RemoteLateAudioCuts.${remote}`)),
        latenessLatestFrames: Number(pick(`RemoteLatenessLatestTransportFrames.${remote}`)),
        roomFollowFrames: Number(pick("RoomFollowFrames")),
        alignmentErrorFrames: Number(pick(`RemoteQueueAlignmentErrorFrames.${remote}`)),
        positionFrames: Number(pick("PlaybackPresentationPositionFrames")),
        ticks: Number(pick("MonotonicTicks")),
        musicUnderruns: Number(pick("MusicUnderruns")),
        musicBufferFill: Number(pick("MusicBufferFill")),
        xruns: Number(pick("XRuns")),
        staleCallbacks: Number(pick("StaleCallbacks")),
        bridgeUnderruns: Number(pick("ClockBridgeUnderruns")),
        bridgeOverruns: Number(pick("ClockBridgeOverruns")),
        driftPpm: Number(pick("DriftPpm")),
        presentationJumps: Number(pick("PresentationJumps")),
        renderClockSkipFrames: Number(pick("RenderClockSkipFrames")),
        deadlineMisses: Number(pick("DeadlineMisses")),
        presentationJumpMaxNs: Number(pick("PresentationJumpMaxNs")),
      };
    })));
  }
  for (const client of clients) {
    await audio(client, "StopRecording");
    report[`recording${client.name}`] = (await audio(client, "GetRecordingState", { details: true })).trim();
  }
  report.rate = rate;
  report.startFrame = frame;
  report.samples = samples;
} finally {
  if (roomId) await request("POST", `/rooms/${roomId}/leave`, { participantId: clients[0].participantId }).catch(() => undefined);
  for (const child of processes) child.kill();
  writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ outDir, last: report.samples?.at(-1) }, null, 1));
