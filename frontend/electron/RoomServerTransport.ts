import { sendAudioRequest } from "./AudioServiceTransport";

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
const roomServerApiBase = process.env.AD_VOICE_ROOM_SERVER ?? `http://${roomServerHost}:8081`;
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
let activeVoiceParticipant: string | undefined;

const requireOk = (response: RoomServerResponse): void => {
  if (!response.ok) throw new Error(`Room voice registration failed (${response.status})`);
};

export const joinRoomVoice = async (roomId: string, participantId: string): Promise<unknown> => {
  const registration = await roomServerRequest({
    method: "POST",
    path: "/voice/join",
    body: { roomId, participantId },
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
      localPort: roomServerRelayPort,
      host: roomServerHost,
      remotePort: roomServerRelayPort,
      voiceToken,
    },
    });
    if (response.status !== 0) throw new Error(response.text || "AudioService rejected voice session");
    activeVoiceParticipant = participantId;
    return response;
  } catch (error) {
    await roomServerRequest({ method: "POST", path: "/voice/leave", body: { participantId } });
    throw error;
  }
};

export const leaveRoomVoice = async (): Promise<void> => {
  await sendAudioRequest({ command: "LeaveMediaSession" }).catch(() => undefined);
  const participantId = activeVoiceParticipant;
  activeVoiceParticipant = undefined;
  if (!participantId) return;
  await roomServerRequest({ method: "POST", path: "/voice/leave", body: { participantId } });
};
