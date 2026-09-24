import dgram from "node:dgram";

const base = process.env.AD_VOICE_ROOM_SERVER_API ?? "http://130.61.169.61:8081";
const host = process.env.AD_VOICE_ROOM_SERVER_HOST ?? "130.61.169.61";
const participantId = `relay-probe-${crypto.randomUUID()}`;
const request = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${route} failed (${response.status})`);
  return response.json();
};
const participantKey = id => {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
};
const packet = (sequence, token) => {
  // Keep this probe on the production AudioService wire format so it cannot report a false
  // positive while real clients are rejected by an outdated relay.
  const bytes = Buffer.alloc(45);
  bytes.writeUInt32LE(0x32445541, 0);
  bytes.writeUInt16LE(3, 4);
  bytes.writeUInt16LE(44, 6);
  bytes.writeUInt32LE(sequence, 8);
  bytes.writeUInt32LE(participantKey(participantId), 12);
  bytes.writeBigUInt64LE(BigInt(`0x${token}`), 16);
  bytes.writeBigUInt64LE(BigInt(sequence * 240), 24);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(240, 34);
  bytes.writeUInt32LE(0, 36);
  bytes.writeUInt32LE(1, 40);
  return bytes;
};

const room = await request("POST", "/rooms", { participantId, displayName: "Relay Probe" });
const voice = await request("POST", "/voice/join", { roomId: room.roomId, participantId });
const socket = dgram.createSocket("udp4");
const sentAt = new Map();
let measuredRtt = 0;
socket.on("message", message => {
  const sequence = message.readUInt32LE(8);
  const start = sentAt.get(sequence);
  if (start) measuredRtt = performance.now() - start;
});
try {
  await new Promise(resolve => socket.bind(0, resolve));
  for (let sequence = 1; sequence <= 15 && measuredRtt === 0; sequence += 1) {
    sentAt.set(sequence, performance.now());
    socket.send(packet(sequence, voice.voiceToken), 40000, host);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!(measuredRtt > 0)) throw new Error("Oracle relay did not return an RTT probe");
  console.log(JSON.stringify({ roomId: room.roomId, roundTripMs: measuredRtt }));
} finally {
  socket.close();
  await request("POST", `/rooms/${room.roomId}/leave`, { participantId }).catch(() => undefined);
}
