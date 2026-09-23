import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const executable = path.join(root, "AudioService", "build", "Release", "AudioService.exe");
const base = process.env.AD_VOICE_ROOM_SERVER_API ?? "http://130.61.169.61:8081";
const suffix = crypto.randomUUID().slice(0, 8);
const requestedBackends = (process.env.AD_VOICE_SMOKE_BACKENDS ?? "wasapi-shared,wasapi-shared").split(",");
const oneWay = process.env.AD_VOICE_SMOKE_ONE_WAY === "1";
const clients = [1, 2].map(number => ({
  participantId: `voice-smoke-${suffix}-${number}`,
  pipe: `ADVoice.RoomSmoke.${suffix}.${number}`
}));
const processes = clients.map(client => spawn(executable, [], {
  env: { ...process.env, AD_VOICE_AUDIO_ENDPOINT: "\\\\.\\pipe\\" + client.pipe },
  windowsHide: true,
  stdio: "ignore"
}));

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const request = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${route} failed (${response.status})`);
  return response.status === 204 ? null : response.json();
};
const audio = async (pipeName, line) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection("\\\\.\\pipe\\" + pipeName);
        let output = "";
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(output);
        };
        socket.once("connect", () => socket.write(`${line}\n`));
        socket.on("data", chunk => { output += chunk.toString("utf8"); });
        socket.once("end", finish);
        socket.once("close", finish);
        socket.once("error", error => output.endsWith("\n") ? finish() : reject(error));
      });
    } catch (error) {
      if (attempt === 29) throw error;
      await delay(100);
    }
  }
  throw new Error("AudioService pipe did not open");
};
const diagnosticNumber = (text, key) => Number(new RegExp(`${key}: ([0-9.]+)`).exec(text)?.[1] ?? 0);
const diagnosticText = (text, key) => new RegExp(`${key}: ([^\\r\\n]+)`).exec(text)?.[1] ?? "missing";

let roomId = "";
try {
  const room = await request("POST", "/rooms", { participantId: clients[0].participantId, displayName: "Voice One" });
  roomId = room.roomId;
  await request("POST", `/rooms/${roomId}/join`, { participantId: clients[1].participantId, displayName: "Voice Two" });
  const tokens = await Promise.all(clients.map(client => request("POST", "/voice/join", {
    roomId, participantId: client.participantId
  }).then(value => value.voiceToken)));
  const reconfigureResponses = await Promise.all(clients.map((client, index) => audio(client.pipe,
    `1|Reconfigure|backend=${requestedBackends[index] ?? "wasapi-shared"}|rate=48000|period=256|inChannels=1|outChannels=2`)));
  const startResponses = await Promise.all(clients.map(client => audio(client.pipe, "1|StartSession")));
  await Promise.all(clients.map((client, index) => audio(client.pipe,
    `1|AddRemoteParticipant|participantId=${clients[1 - index].participantId}`)));
  await Promise.all(clients.map((client, index) => audio(client.pipe,
    `1|JoinMediaSession|localParticipantId=${client.participantId}|localPort=0|host=130.61.169.61|remotePort=40000|voiceToken=${tokens[index]}`)));
  await delay(4000);
  const diagnostics = await Promise.all(clients.map(client => audio(client.pipe, "1|GetDiagnostics")));
  const result = diagnostics.map((text, index) => ({
    client: index + 1,
    reconfigureResponse: reconfigureResponses[index].trim(),
    startResponse: startResponses[index].trim(),
    serviceState: diagnosticText(text, "ServiceState"),
    sessionState: diagnosticText(text, "SessionState"),
    lastFailure: diagnosticText(text, "LastFailureMessage"),
    inputRms: diagnosticNumber(text, "InputRMS"),
    inputSampleRate: diagnosticNumber(text, "RuntimeInputSampleRate"),
    sessionFrame: diagnosticNumber(text, "SessionFrame"),
    sent: diagnosticNumber(text, "NetworkPacketsSent"),
    received: diagnosticNumber(text, "NetworkPacketsReceived"),
    remoteLevel: diagnosticNumber(text, `RemoteLevel\\.${clients[1 - index].participantId}`),
    roundTripMs: diagnosticNumber(text, "NetworkRoundTripMs"),
    remoteJitterMs: diagnosticNumber(text, `RemoteJitterMs\\.${clients[1 - index].participantId}`),
    remoteTargetDelayFrames: diagnosticNumber(
      text, `RemoteTargetDelayFrames\\.${clients[1 - index].participantId}`)
  }));
  const failed = oneWay
    ? result[0].sent === 0 || result[1].received === 0 || result[1].remoteLevel === 0
    : result.some(item => item.sent === 0 || item.received === 0 || item.remoteLevel === 0 ||
        item.roundTripMs === 0 || item.remoteTargetDelayFrames === 0);
  if (failed) {
    throw new Error(`Voice relay smoke failed: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  if (roomId) await request("POST", `/rooms/${roomId}/leave`, { participantId: clients[0].participantId }).catch(() => undefined);
  for (const process of processes) process.kill();
}
