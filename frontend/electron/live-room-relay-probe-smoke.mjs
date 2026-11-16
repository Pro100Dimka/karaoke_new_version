import dgram from 'node:dgram';
import {
  relayProbePacket,
  roomSmokeIdentities,
} from './multi-electron-room-plan.mjs';

const base = process.env.AD_VOICE_ROOM_SERVER_API ?? 'https://130.61.169.61';
const host = process.env.AD_VOICE_ROOM_SERVER_HOST ?? '130.61.169.61';
const identities = roomSmokeIdentities();
const participantId = identities.create();
const request = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...identities.headers(base, participantId),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} failed (${response.status})`);
  return response.json();
};
const participantKey = (id) => {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
};
const packet = (sequence, token) =>
  relayProbePacket(
    sequence,
    participantKey(participantId),
    BigInt(`0x${token}`),
  );

const room = await request('POST', '/rooms', {
  participantId,
  displayName: 'Relay Probe',
});
const voice = await request('POST', '/voice/join', {
  roomId: room.roomId,
  participantId,
});
const socket = dgram.createSocket('udp4');
const sentAt = new Map();
let measuredRtt = 0;
socket.on('message', (message) => {
  const sequence = message.readUInt32LE(8);
  const start = sentAt.get(sequence);
  if (start) measuredRtt = performance.now() - start;
});
try {
  await new Promise((resolve) => socket.bind(0, resolve));
  for (let sequence = 1; sequence <= 15 && measuredRtt === 0; sequence += 1) {
    sentAt.set(sequence, performance.now());
    socket.send(packet(sequence, voice.voiceToken), 40000, host);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(measuredRtt > 0))
    throw new Error('Oracle relay did not return an RTT probe');
  console.log(
    JSON.stringify({ roomId: room.roomId, roundTripMs: measuredRtt }),
  );
} finally {
  socket.close();
  await request('POST', `/rooms/${room.roomId}/leave`, { participantId }).catch(
    () => undefined,
  );
}
