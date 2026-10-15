// One-off observer: server room timing + both AudioServices' advertised route requirement, 1 Hz.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [code, out] = process.argv.slice(2);
const server = "http://130.61.169.61:8081";
const control = String.raw`D:\Git\karaoke_new_version\AudioService\build\Release\AudioControl.exe`;
const env = { ...process.env, AD_VOICE_AUDIO_ENDPOINT: String.raw`\\.\pipe\ADVoice.AudioService.Dev.v1` };
const keys = /^(RoomRequestedDelayFrames|RoomPlayoutDelayFrames|RoomCompensationFrames|RoomReturnRequirementFrames|RoomArrivalRequirementFrames|RoomVoiceRoute|NetworkDirectPeerCount|NetworkRoundTripMs|PlaybackState|PlaybackPositionFrames|OutputDriverLatencyFrames|RuntimeOutputLatencyFrames|RuntimeOutputPeriodFrames|RemoteTargetDelayFrames\.[^_].*|RemoteJitterMs\.[^_].*|RemoteLateAudioCuts\.[^_].*|RemoteDirectFirstPackets\.[^_].*)$/;
const parse = (text) => Object.fromEntries(text.split(/\r?\n/).map((l) => l.split(": ")).filter((p) => p.length === 2 && keys.test(p[0])));
// The laptop is read through one persistent ssh shell, so a sample does not pay an ssh handshake.
const shell = spawn("ssh", ["pro10@192.168.0.194", "cmd"], { stdio: ["pipe", "pipe", "ignore"] });
let buffer = "";
shell.stdout.on("data", (chunk) => { buffer += chunk.toString(); });
const laptop = async () => {
  buffer = "";
  shell.stdin.write("ac.bat GetDiagnostics & echo ===END===\r\n");
  for (let i = 0; i < 40 && !buffer.includes("===END===\r\n"); i++) await new Promise((r) => setTimeout(r, 50));
  return parse(buffer);
};
for (;;) {
  const at = new Date().toISOString();
  let room = {};
  try { room = await (await fetch(`${server}/rooms/${code}`)).json(); } catch {}
  let host = {};
  try { host = parse(execFileSync(control, ["GetDiagnostics"], { env, encoding: "utf8" })); } catch {}
  const lap = await laptop();
  appendFileSync(out, JSON.stringify({ at, room: { playbackState: room.playbackState, roomPlayoutDelayMs: room.roomPlayoutDelayMs,
    timingSource: room.roomTimingSource, participants: (room.participants ?? []).map((p) => ({ name: p.displayName ?? p.name, voiceLatencyMs: p.voiceLatencyMs,
      route: p.voiceRoute, calibrated: p.voiceRouteCalibrated, returnMs: p.returnRequirementMs, arrivalMs: p.arrivalRequirementMs })) }, host, laptop: lap }) + "\n");
  await new Promise((r) => setTimeout(r, 1000));
}
