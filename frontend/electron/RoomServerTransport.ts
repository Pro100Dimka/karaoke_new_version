import { sendAudioRequest } from "./AudioServiceTransport";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

export interface RoomServerRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RoomServerResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

// Shared room/voice server: a single fixed deployment all installs connect to, not something the user configures.
const roomServerHost = process.env.AD_VOICE_ROOM_SERVER_HOST ?? "130.61.169.61";
export const roomServerApiBase = process.env.AD_VOICE_ROOM_SERVER ?? `http://${roomServerHost}:8081`;
const roomServerRelayPort = Number(process.env.AD_VOICE_ROOM_SERVER_RELAY_PORT ?? "40000");

export const roomServerRequest = async (request: RoomServerRequest): Promise<RoomServerResponse> => {
  try {
    const response = await fetch(`${roomServerApiBase}${request.path}`, {
      method: request.method,
      headers: { "Content-Type": "application/json", ...request.headers },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    // The shared room server being unreachable is an expected state (offline, DNS hiccup), reported as data.
    const message = error instanceof Error ? error.message : "Room server is unreachable";
    return { status: 503, ok: false, body: { code: "RoomServerUnavailable", message } };
  }
};

/** Opens this participant's voice session against the room server's relay, via AudioService's UDP engine. */
interface ActiveVoiceSession {
  roomId: string;
  participantId: string;
  voiceToken: string;
}

const machineId = createHash("sha256").update(hostname()).digest("hex").slice(0, 32);
let activeVoice: ActiveVoiceSession | undefined;
let directPeerTimer: NodeJS.Timeout | undefined;

const requireOk = (response: RoomServerResponse): void => {
  if (!response.ok) throw new Error(`Room voice registration failed (${response.status})`);
};

const synchronizeDirectPeers = async (session: ActiveVoiceSession): Promise<void> => {
  const response = await roomServerRequest({
    method: "POST",
    path: "/voice/peers",
    body: { ...session, machineId },
  });
  if (!response.ok || activeVoice !== session || !response.body || typeof response.body !== "object") return;
  const peers = (response.body as { peers?: unknown }).peers;
  if (!Array.isArray(peers)) return;
  await Promise.all(peers.map(async peer => {
    if (!peer || typeof peer !== "object") return;
    const candidate = peer as Record<string, unknown>;
    if (typeof candidate.participantId !== "string" || typeof candidate.host !== "string" ||
        typeof candidate.port !== "number" || typeof candidate.voiceToken !== "string") return;
    await sendAudioRequest({
      command: "SetDirectPeer",
      args: {
        participantId: candidate.participantId,
        host: candidate.host,
        port: candidate.port,
        voiceToken: candidate.voiceToken,
      },
    });
  }));
};

export const joinRoomVoice = async (roomId: string, participantId: string): Promise<unknown> => {
  const registration = await roomServerRequest({
    method: "POST",
    path: "/voice/join",
    body: { roomId, participantId, machineId },
  });
  requireOk(registration);
  const voiceToken = registration.body && typeof registration.body === "object"
    ? (registration.body as Record<string, unknown>).voiceToken
    : undefined;
  if (typeof voiceToken !== "string" || !/^[0-9a-f]{16}$/i.test(voiceToken)) {
    throw new Error("Room voice registration returned an invalid token");
  }
  try {
    const response = await sendAudioRequest({
    command: "JoinMediaSession",
    args: {
      localParticipantId: participantId,
      // Every desktop instance needs its own source port. The OS-selected ephemeral port is
      // learned by the relay from the first authenticated packet and also works behind NAT.
      localPort: 0,
      host: roomServerHost,
      remotePort: roomServerRelayPort,
      voiceToken,
    },
    });
    if (response.status !== 0) throw new Error(response.text || "AudioService rejected voice session");
    const localPortMatch = /\blocalPort=(\d+)\b/.exec(response.text ?? "");
    const localPort = Number(localPortMatch?.[1] ?? 0);
    const session = { roomId, participantId, voiceToken };
    activeVoice = session;
    if (localPort > 0) {
      requireOk(await roomServerRequest({
        method: "POST",
        path: "/voice/candidate",
        body: { ...session, machineId, localPort },
      }));
      await synchronizeDirectPeers(session);
      directPeerTimer = setInterval(() => {
        void synchronizeDirectPeers(session);
      }, 1_000);
      directPeerTimer.unref?.();
    }
    return response;
  } catch (error) {
    await roomServerRequest({ method: "POST", path: "/voice/leave", body: { participantId } });
    throw error;
  }
};

export const leaveRoomVoice = async (): Promise<void> => {
  if (directPeerTimer) clearInterval(directPeerTimer);
  directPeerTimer = undefined;
  await sendAudioRequest({ command: "LeaveMediaSession" }).catch(() => undefined);
  const session = activeVoice;
  activeVoice = undefined;
  if (!session) return;
  await roomServerRequest({ method: "POST", path: "/voice/leave", body: { participantId: session.participantId } });
};
