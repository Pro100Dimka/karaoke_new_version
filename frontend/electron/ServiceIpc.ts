import type { WebContents } from 'electron';
import { roomVoiceEffects } from './ipcChannels';
import {
  sendAudioRequest,
  subscribeAudioNotifications,
  type AudioRequest,
} from './AudioServiceTransport';
import type { BackendEndpoint } from './BackendEndpoint';
import { ipcChannels } from './ipcChannels';
import type { createKeyboardLightingProvider } from './KeyboardLighting';
import { requireObject, requireString } from './RequestValidation';
import {
  joinRoomVoice,
  leaveRoomVoice,
  roomServerRequest,
  roomVoiceLevels,
  roomVoiceRoute,
  setRoomVoiceParticipantGain,
  setRoomVoiceParticipantEffect,
} from './RoomServerTransport';
import { withDevice } from './SocialIdentity';
import { requestFileDeclaration } from './TransferPermissions';
import type { TrustedIpc } from './TrustedIpc';

interface BackendRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Only string header values cross the IPC boundary. */
const stringFields = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
};

const requireBackendRequest = (value: unknown): BackendRequest => {
  const request = requireObject(value, 'request');
  const method = requireString(request.method, 'method').toUpperCase();
  const requestPath = requireString(request.path, 'path');
  if (!httpMethods.has(method)) throw new TypeError('Unsupported HTTP method');
  if (!requestPath.startsWith('/') || requestPath.startsWith('//'))
    throw new TypeError('Invalid backend path');
  return {
    method,
    path: requestPath,
    body: request.body,
    headers: stringFields(request.headers),
  };
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const registerBackendRequests = (
  trustedIpc: TrustedIpc,
  backendEndpoint: BackendEndpoint,
  audioEvent: (reason: string) => void,
) => {
  const subscriptions = new Map<string, () => void>();
  const radioRequests = new WeakMap<WebContents, AbortController>();
  const radioOwners = new WeakSet<WebContents>();
  const cancelRadio = (sender: WebContents) => {
    radioRequests.get(sender)?.abort();
    radioRequests.delete(sender);
  };
  const beginRadio = (sender: WebContents) => {
    cancelRadio(sender);
    const request = new AbortController();
    radioRequests.set(sender, request);
    if (!radioOwners.has(sender)) {
      radioOwners.add(sender);
      sender.once('destroyed', () => cancelRadio(sender));
      sender.on('render-process-gone', () => cancelRadio(sender));
      sender.on('did-start-navigation', (navigation) => {
        if (navigation.isMainFrame && !navigation.isSameDocument)
          cancelRadio(sender);
      });
    }
    if (sender.isDestroyed()) cancelRadio(sender);
    return request;
  };
  const stopNotifications = () => {
    for (const stop of subscriptions.values()) stop();
    subscriptions.clear();
  };
  let observedSender = false;
  trustedIpc.handle(ipcChannels.audioSubscribe, (event, raw: unknown) => {
    const request = requireObject(raw, 'Audio subscription');
    const command = requireString(request.command, 'command');
    subscriptions.get(command)?.();
    subscriptions.delete(command);
    if (request.intervalMs === null) return;
    const interval = Number(request.intervalMs);
    const stop = subscribeAudioNotifications(command, interval, (value) => {
      if (!event.sender.isDestroyed())
        event.sender.send(ipcChannels.audioNotification, { command, value });
    });
    subscriptions.set(command, stop);
    if (!observedSender) {
      observedSender = true;
      event.sender.on('render-process-gone', stopNotifications);
      event.sender.on('did-start-navigation', (navigation) => {
        if (navigation.isMainFrame && !navigation.isSameDocument)
          stopNotifications();
      });
      event.sender.once('destroyed', () => {
        observedSender = false;
        stopNotifications();
      });
    }
  });
  trustedIpc.handle(ipcChannels.pythonRequest, async (event, raw: unknown) => {
    const request = requireBackendRequest(raw);
    if (
      request.method === 'POST' &&
      /^\/songs\/[^/]+\/processing(?:\/(?:melody|lyrics))?$/.test(request.path)
    ) {
      const settings = await backendEndpoint.request('/settings', {
        method: 'GET',
      });
      if (!settings.ok) throw new Error('Processing settings are unavailable');
      const value = requireObject(settings.body, 'processing settings');
      if (value.processingBackend !== 'Local') {
        const ticket = await requestFileDeclaration('processing', request.path);
        request.headers = {
          ...request.headers,
          'X-AD-Voice-File-Declaration': ticket,
        };
      }
    }
    // A replaced station must release its HTTP request and backend resolver work.
    const radio =
      request.method === 'GET' && /^\/radio\/youtube(?:\?|$)/.test(request.path)
        ? beginRadio(event.sender)
        : undefined;
    try {
      return await backendEndpoint.request(request.path, {
        method: request.method,
        signal: radio?.signal,
        headers: { 'Content-Type': 'application/json', ...request.headers },
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (error) {
      if (radio?.signal.aborted)
        return {
          status: 499,
          ok: false,
          body: {
            code: 'RequestCancelled',
            message: 'Radio request was cancelled',
          },
        };
      // A backend that is still starting or restarting is an expected state, reported as data instead of an IPC failure.
      const message = errorMessage(error, 'Python backend is unreachable');
      return {
        status: 503,
        ok: false,
        body: { code: 'BackendUnavailable', message },
      };
    } finally {
      if (radio && radioRequests.get(event.sender) === radio)
        radioRequests.delete(event.sender);
    }
  });
  trustedIpc.handle(ipcChannels.audioRequest, async (event, raw: unknown) => {
    const record = requireObject(raw, 'Audio request');
    const command = requireString(record.command, 'command');
    if (command === 'StopRadio') cancelRadio(event.sender);
    // The transport checks every argument's name and value before anything reaches the pipe.
    const args =
      record.args && typeof record.args === 'object'
        ? (record.args as AudioRequest['args'])
        : undefined;
    try {
      const response = await sendAudioRequest({ command, args });
      if (response.status !== 0) {
        console.error(`AudioService ${command} failed: ${response.text}`);
        audioEvent(`command-failed:${command}`);
      }
      if (command === 'GetDiagnostics' && response.status === 0)
        return {
          ...response,
          text: `${response.text}\nRoomVoiceRoute: ${roomVoiceRoute()}\n`,
        };
      return response;
    } catch (error) {
      // The pipe does not exist until AudioService has finished starting; report that as an ordinary failed response.
      const text = `AudioService unavailable: ${errorMessage(error, 'AudioService is unreachable')}`;
      console.error(`AudioService ${command} failed: ${text}`);
      audioEvent(`transport-failed:${command}`);
      return { status: -1, text };
    }
  });
};

const registerRoomRequests = (trustedIpc: TrustedIpc) => {
  trustedIpc.handle(ipcChannels.roomRequest, async (_event, raw: unknown) =>
    roomServerRequest(await withDevice(requireBackendRequest(raw))),
  );
  trustedIpc.handle(ipcChannels.joinRoomVoice, async (_event, raw: unknown) => {
    const identity = requireObject(raw, 'voice identity');
    return joinRoomVoice(
      requireString(identity.roomId, 'roomId'),
      requireString(identity.participantId, 'participantId'),
    );
  });
  trustedIpc.handle(ipcChannels.leaveRoomVoice, async () => leaveRoomVoice());
  trustedIpc.handle(ipcChannels.roomVoiceLevels, async () => roomVoiceLevels());
  trustedIpc.handle(
    ipcChannels.setRoomVoiceParticipantGain,
    async (_event, raw: unknown) => {
      const value = requireObject(raw, 'participant gain');
      const gain = Number(value.gain);
      if (!Number.isFinite(gain)) throw new TypeError('gain must be a number');
      await setRoomVoiceParticipantGain(
        requireString(value.participantId, 'participantId'),
        gain,
      );
    },
  );
  trustedIpc.handle(
    ipcChannels.setRoomVoiceParticipantEffect,
    async (_event, raw: unknown) => {
      const request = requireObject(raw, 'participant effect');
      const effect = roomVoiceEffects.find((name) => name === request.effect);
      const value = Number(request.value);
      if (!effect || !Number.isFinite(value))
        throw new TypeError('Invalid voice effect');
      await setRoomVoiceParticipantEffect(
        requireString(request.participantId, 'participantId'),
        effect,
        value,
      );
    },
  );
};

const registerKeyboardLighting = (
  trustedIpc: TrustedIpc,
  keyboardLighting: ReturnType<typeof createKeyboardLightingProvider>,
) => {
  trustedIpc.handle(
    ipcChannels.keyboardLightingCapabilities,
    async () =>
      keyboardLighting?.capabilities() ?? { available: false, deviceCount: 0 },
  );
  trustedIpc.handle(
    ipcChannels.setKeyboardLighting,
    async (_event, raw: unknown) => {
      const { enabled, brightness, color } = requireObject(
        raw,
        'lighting request',
      );
      if (
        typeof enabled !== 'boolean' ||
        typeof brightness !== 'number' ||
        typeof color !== 'string'
      )
        throw new TypeError('invalid lighting request');
      await keyboardLighting?.apply({ enabled, brightness, color });
    },
  );
};

/** Requests the renderer forwards to the Python backend, AudioService, the Room Server and the keyboard. */
export const registerServiceIpc = (
  trustedIpc: TrustedIpc,
  backendEndpoint: BackendEndpoint,
  keyboardLighting: ReturnType<typeof createKeyboardLightingProvider>,
  audioEvent: (reason: string) => void = () => undefined,
): void => {
  registerBackendRequests(trustedIpc, backendEndpoint, audioEvent);
  registerRoomRequests(trustedIpc);
  registerKeyboardLighting(trustedIpc, keyboardLighting);
};
