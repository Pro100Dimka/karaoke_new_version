import { sendAudioRequest } from "./AudioServiceTransport";
import { withRoomKey } from "./RoomIdentity";
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
const legacyRoomServerUrl = (() => {
  try {
    return process.env.AD_VOICE_ROOM_SERVER
      ? new URL(process.env.AD_VOICE_ROOM_SERVER)
      : undefined;
  } catch {
    return undefined;
  }
})();
const roomServerHost =
  process.env.AD_VOICE_ROOM_SERVER_HOST ??
  legacyRoomServerUrl?.hostname ??
  "130.61.169.61";
const roomServerPort =
  process.env.AD_VOICE_ROOM_SERVER_PORT ?? legacyRoomServerUrl?.port ?? "8081";
const roomServerProtocol =
  legacyRoomServerUrl?.protocol === "https:" ? "https:" : "http:";
export const roomServerApiBase = `${roomServerProtocol}//${roomServerHost}:${roomServerPort}`;
const roomServerRelayPort = Number(
  process.env.AD_VOICE_ROOM_SERVER_RELAY_PORT ?? "40000",
);

export const roomServerRequest = async (
  request: RoomServerRequest,
): Promise<RoomServerResponse> => {
  const controller = new AbortController();
  // Room changes use a 25-second server long poll; ordinary control requests should fail sooner.
  const timeoutMs = /\/changes(?:\?|$)/.test(request.path) ? 35_000 : 10_000;
  const timeout = setTimeout(
    () => controller.abort(new Error("Room server request timed out")),
    timeoutMs,
  );
  try {
    const response = await fetch(`${roomServerApiBase}${request.path}`, {
      method: request.method,
      // Every room request carries this profile's room key: the server accepts a participant id only from its owner.
      headers: await withRoomKey({
        "Content-Type": "application/json",
        ...request.headers,
      }),
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const body: unknown = text ? JSON.parse(text) : null;
    return { status: response.status, ok: response.ok, body };
  } catch (error) {
    // The shared room server being unreachable is an expected state (offline, DNS hiccup), reported as data.
    const message =
      error instanceof Error ? error.message : "Room server is unreachable";
    return {
      status: 503,
      ok: false,
      body: { code: "RoomServerUnavailable", message },
    };
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

const machineId = createHash("sha256")
  .update(hostname())
  .digest("hex")
  .slice(0, 32);
let activeVoice: ActiveVoiceSession | undefined;
let latestVoiceLevels: Record<string, number> = {};
let pushedVoiceLevels = false;
let nextLegacyLevelsRequestAt = 0;
let voiceGeneration = 0;
let transitionTail = Promise.resolve();
let pendingTransitions = 0;
const maximumPendingTransitions = 32;

const transition = <T>(
  operation: (generation: number) => Promise<T>,
): Promise<T> => {
  if (pendingTransitions >= maximumPendingTransitions)
    return Promise.reject(new Error("Too many pending voice transitions"));
  pendingTransitions += 1;
  const generation = ++voiceGeneration;
  const result = transitionTail.then(() => operation(generation));
  transitionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    pendingTransitions -= 1;
  });
};

const requireCurrent = (generation: number) => {
  if (generation !== voiceGeneration)
    throw new Error("Room voice transition was superseded");
};

const requireOk = (response: RoomServerResponse): void => {
  if (!response.ok)
    throw new Error(`Room voice registration failed (${response.status})`);
};

const closeActiveVoice = async (force = false): Promise<void> => {
  const session = activeVoice;
  activeVoice = undefined;
  latestVoiceLevels = {};
  pushedVoiceLevels = false;
  nextLegacyLevelsRequestAt = 0;
  if (session || force)
    await sendAudioRequest({ command: "LeaveMediaSession" }).catch(
      () => undefined,
    );
  if (session)
    await roomServerRequest({
      method: "POST",
      path: "/voice/leave",
      body: { participantId: session.participantId },
    });
};

export const joinRoomVoice = (
  roomId: string,
  participantId: string,
): Promise<unknown> =>
  transition(async (generation) => {
    requireCurrent(generation);
    await closeActiveVoice();
    requireCurrent(generation);
    let registered = false;
    try {
      const registration = await roomServerRequest({
        method: "POST",
        path: "/voice/join",
        body: { roomId, participantId, machineId },
      });
      requireOk(registration);
      registered = true;
      const voiceToken =
        registration.body && typeof registration.body === "object"
          ? (registration.body as Record<string, unknown>).voiceToken
          : undefined;
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
      if (response.status !== 0)
        throw new Error(response.text || "AudioService rejected voice session");
      requireCurrent(generation);
      return response;
    } catch (error) {
      if (activeVoice?.generation === generation) await closeActiveVoice();
      else if (registered)
        await roomServerRequest({
          method: "POST",
          path: "/voice/leave",
          body: { participantId },
        });
      throw error;
    }
  });

export const leaveRoomVoice = (): Promise<void> =>
  transition(async (generation) => {
    requireCurrent(generation);
    await closeActiveVoice(true);
  });

export const roomVoiceLevels = async (): Promise<Record<string, number>> => {
  const session = activeVoice;
  if (!session) return {};
  const now = Date.now();
  if (pushedVoiceLevels || now < nextLegacyLevelsRequestAt)
    return { ...latestVoiceLevels };
  nextLegacyLevelsRequestAt = now + 1_000;
  const response = await roomServerRequest({
    method: "POST",
    path: "/voice/levels",
    body: {
      roomId: session.roomId,
      participantId: session.participantId,
      machineId,
      voiceToken: session.voiceToken,
    },
  });
  if (
    activeVoice?.generation !== session.generation ||
    !response.ok ||
    !response.body ||
    typeof response.body !== "object"
  )
    return { ...latestVoiceLevels };
  latestVoiceLevels = Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
  return { ...latestVoiceLevels };
};

export const setRoomVoiceParticipantGain = async (
  sourceParticipantId: string,
  gain: number,
): Promise<void> => {
  const session = activeVoice;
  if (!session) throw new Error("Room voice session is not active");
  const response = await roomServerRequest({
    method: "POST",
    path: "/voice/participant-gain",
    body: {
      roomId: session.roomId,
      participantId: session.participantId,
      sourceParticipantId,
      voiceToken: session.voiceToken,
      gain: Math.max(0, Math.min(2, gain)),
    },
  });
  requireOk(response);
};

/** Accepts the transient room message carried by the already-open social WebSocket. */
export const acceptRoomVoiceLevels = (message: unknown): void => {
  if (!activeVoice || !message || typeof message !== "object") return;
  const value = message as Record<string, unknown>;
  if (
    value.type !== "voiceLevels" ||
    value.roomId !== activeVoice.roomId ||
    !value.levels ||
    typeof value.levels !== "object"
  )
    return;
  latestVoiceLevels = Object.fromEntries(
    Object.entries(value.levels as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
  pushedVoiceLevels = true;
};
