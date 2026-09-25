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
  const controller = new AbortController();
  // Room changes use a 25-second server long poll; ordinary control requests should fail sooner.
  const timeoutMs = /\/changes(?:\?|$)/.test(request.path) ? 35_000 : 10_000;
  const timeout = setTimeout(() => controller.abort(new Error("Room server request timed out")), timeoutMs);
  try {
    const response = await fetch(`${roomServerApiBase}${request.path}`, {
      method: request.method,
      headers: { "Content-Type": "application/json", ...request.headers },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    // The shared room server being unreachable is an expected state (offline, DNS hiccup), reported as data.
    const message = error instanceof Error ? error.message : "Room server is unreachable";
    return { status: 503, ok: false, body: { code: "RoomServerUnavailable", message } };
  } finally {
    clearTimeout(timeout);
  }
};

/** Opens this participant's voice session against the room server's relay, via AudioService's UDP engine. */
interface ActiveVoiceSession {
  roomId: string;
  participantId: string;
  voiceToken: string;
  generation: number;
}

const machineId = createHash("sha256").update(hostname()).digest("hex").slice(0, 32);
let activeVoice: ActiveVoiceSession | undefined;
let directPeerTimer: NodeJS.Timeout | undefined;
let voiceGeneration = 0;
let transitionTail = Promise.resolve();
let pendingTransitions = 0;
const maximumPendingTransitions = 32;
const credentials = ({ roomId, participantId, voiceToken }: ActiveVoiceSession) =>
  ({ roomId, participantId, voiceToken, machineId });
const isCurrent = (session: ActiveVoiceSession) => activeVoice === session && session.generation === voiceGeneration;
const stopPeerTimer = () => {
  clearTimeout(directPeerTimer);
  directPeerTimer = undefined;
};

const transition = <T>(operation: (generation: number) => Promise<T>): Promise<T> => {
  if (pendingTransitions >= maximumPendingTransitions) return Promise.reject(new Error("Too many pending voice transitions"));
  pendingTransitions += 1;
  const generation = ++voiceGeneration;
  stopPeerTimer();
  const result = transitionTail.then(() => operation(generation));
  transitionTail = result.then(() => undefined, () => undefined);
  return result.finally(() => { pendingTransitions -= 1; });
};

const requireCurrent = (generation: number) => {
  if (generation !== voiceGeneration) throw new Error("Room voice transition was superseded");
};

const requireOk = (response: RoomServerResponse): void => {
  if (!response.ok) throw new Error(`Room voice registration failed (${response.status})`);
};

const synchronizeDirectPeers = async (session: ActiveVoiceSession): Promise<void> => {
  if (!isCurrent(session)) return;
  const response = await roomServerRequest({
    method: "POST",
    path: "/voice/peers",
    body: credentials(session),
  });
  if (!response.ok || !isCurrent(session) || !response.body || typeof response.body !== "object") return;
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

const schedulePeerRefresh = (session: ActiveVoiceSession): void => {
  if (!isCurrent(session)) return;
  directPeerTimer = setTimeout(() => {
    directPeerTimer = undefined;
    void synchronizeDirectPeers(session)
      .catch(error => { console.warn("Room direct peer refresh failed", error); })
      .finally(() => schedulePeerRefresh(session));
  }, 1_000);
  directPeerTimer.unref?.();
};

const closeActiveVoice = async (force = false): Promise<void> => {
  stopPeerTimer();
  const session = activeVoice;
  activeVoice = undefined;
  if (session || force) await sendAudioRequest({ command: "LeaveMediaSession" }).catch(() => undefined);
  if (session) await roomServerRequest({ method: "POST", path: "/voice/leave", body: { participantId: session.participantId } });
};

export const joinRoomVoice = (roomId: string, participantId: string): Promise<unknown> => transition(async generation => {
  requireCurrent(generation);
  await closeActiveVoice();
  requireCurrent(generation);
  let registered = false;
  try {
    const registration = await roomServerRequest({
      method: "POST", path: "/voice/join", body: { roomId, participantId, machineId },
    });
    requireOk(registration);
    registered = true;
    const voiceToken = registration.body && typeof registration.body === "object"
      ? (registration.body as Record<string, unknown>).voiceToken : undefined;
    if (typeof voiceToken !== "string" || !/^[0-9a-f]{16}$/i.test(voiceToken))
      throw new Error("Room voice registration returned an invalid token");
    requireCurrent(generation);
    const session = { roomId, participantId, voiceToken, generation };
    activeVoice = session;
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
    requireCurrent(generation);
    const localPortMatch = /\blocalPort=(\d+)\b/.exec(response.text ?? "");
    const localPort = Number(localPortMatch?.[1] ?? 0);
    if (localPort > 0) {
      requireOk(await roomServerRequest({
        method: "POST",
        path: "/voice/candidate",
        body: { ...credentials(session), localPort },
      }));
      requireCurrent(generation);
      await synchronizeDirectPeers(session);
      requireCurrent(generation);
      schedulePeerRefresh(session);
    }
    return response;
  } catch (error) {
    if (activeVoice?.generation === generation) await closeActiveVoice();
    else if (registered) await roomServerRequest({ method: "POST", path: "/voice/leave", body: { participantId } });
    throw error;
  }
});

export const leaveRoomVoice = (): Promise<void> => transition(async generation => {
  requireCurrent(generation);
  await closeActiveVoice(true);
});
