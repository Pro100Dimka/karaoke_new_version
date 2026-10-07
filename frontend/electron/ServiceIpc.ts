import { sendAudioRequest, type AudioRequest } from "./AudioServiceTransport";
import type { BackendEndpoint } from "./BackendEndpoint";
import { ipcChannels } from "./ipcChannels";
import type { createKeyboardLightingProvider } from "./KeyboardLighting";
import { requireObject, requireString } from "./RequestValidation";
import {
  joinRoomVoice,
  leaveRoomVoice,
  roomServerRequest,
  roomVoiceLevels,
  setRoomVoiceParticipantGain,
} from "./RoomServerTransport";
import { withDevice } from "./SocialIdentity";
import type { TrustedIpc } from "./TrustedIpc";

interface BackendRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Only string header values cross the IPC boundary. */
const stringFields = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const requireBackendRequest = (value: unknown): BackendRequest => {
  const request = requireObject(value, "request");
  const method = requireString(request.method, "method").toUpperCase();
  const requestPath = requireString(request.path, "path");
  if (!httpMethods.has(method)) throw new TypeError("Unsupported HTTP method");
  if (!requestPath.startsWith("/") || requestPath.startsWith("//"))
    throw new TypeError("Invalid backend path");
  return { method, path: requestPath, body: request.body, headers: stringFields(request.headers) };
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const registerBackendRequests = (trustedIpc: TrustedIpc, backendEndpoint: BackendEndpoint) => {
  trustedIpc.handle(ipcChannels.pythonRequest, async (_event, raw: unknown) => {
    const request = requireBackendRequest(raw);
    try {
      return await backendEndpoint.request(request.path, {
        method: request.method,
        headers: { "Content-Type": "application/json", ...request.headers },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (error) {
      // A backend that is still starting or restarting is an expected state, reported as data instead of an IPC failure.
      const message = errorMessage(error, "Python backend is unreachable");
      return { status: 503, ok: false, body: { code: "BackendUnavailable", message } };
    }
  });
  trustedIpc.handle(ipcChannels.audioRequest, async (_event, raw: unknown) => {
    const record = requireObject(raw, "Audio request");
    const command = requireString(record.command, "command");
    // The transport checks every argument's name and value before anything reaches the pipe.
    const args =
      record.args && typeof record.args === "object" ? (record.args as AudioRequest["args"]) : undefined;
    try {
      return await sendAudioRequest({ command, args });
    } catch (error) {
      // The pipe does not exist until AudioService has finished starting; report that as an ordinary failed response.
      return { status: -1, text: `AudioService unavailable: ${errorMessage(error, "AudioService is unreachable")}` };
    }
  });
};

const registerRoomRequests = (trustedIpc: TrustedIpc) => {
  trustedIpc.handle(ipcChannels.roomRequest, async (_event, raw: unknown) =>
    roomServerRequest(await withDevice(requireBackendRequest(raw))),
  );
  trustedIpc.handle(ipcChannels.joinRoomVoice, async (_event, raw: unknown) => {
    const identity = requireObject(raw, "voice identity");
    return joinRoomVoice(
      requireString(identity.roomId, "roomId"),
      requireString(identity.participantId, "participantId"),
    );
  });
  trustedIpc.handle(ipcChannels.leaveRoomVoice, async () => leaveRoomVoice());
  trustedIpc.handle(ipcChannels.roomVoiceLevels, async () => roomVoiceLevels());
  trustedIpc.handle(ipcChannels.setRoomVoiceParticipantGain, async (_event, raw: unknown) => {
    const value = requireObject(raw, "participant gain");
    const gain = Number(value.gain);
    if (!Number.isFinite(gain)) throw new TypeError("gain must be a number");
    await setRoomVoiceParticipantGain(requireString(value.participantId, "participantId"), gain);
  });
};

const registerKeyboardLighting = (
  trustedIpc: TrustedIpc,
  keyboardLighting: ReturnType<typeof createKeyboardLightingProvider>,
) => {
  trustedIpc.handle(
    ipcChannels.keyboardLightingCapabilities,
    async () => keyboardLighting?.capabilities() ?? { available: false, deviceCount: 0 },
  );
  trustedIpc.handle(ipcChannels.setKeyboardLighting, async (_event, raw: unknown) => {
    const { enabled, brightness, color } = requireObject(raw, "lighting request");
    if (typeof enabled !== "boolean" || typeof brightness !== "number" || typeof color !== "string")
      throw new TypeError("invalid lighting request");
    await keyboardLighting?.apply({ enabled, brightness, color });
  });
};

/** Requests the renderer forwards to the Python backend, AudioService, the Room Server and the keyboard. */
export const registerServiceIpc = (
  trustedIpc: TrustedIpc,
  backendEndpoint: BackendEndpoint,
  keyboardLighting: ReturnType<typeof createKeyboardLightingProvider>,
): void => {
  registerBackendRequests(trustedIpc, backendEndpoint);
  registerRoomRequests(trustedIpc);
  registerKeyboardLighting(trustedIpc, keyboardLighting);
};
