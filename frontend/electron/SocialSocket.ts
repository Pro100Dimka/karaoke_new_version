import { deviceSecret, onlineAccountEnabled } from './SocialIdentity';
import { requireSecureRoomUrl } from './RoomIdentity';

export interface SocialPresence {
  displayName: string;
  participantId: string | null;
  roomId: string | null;
}

// Reconnecting after the server went away backs off to this; a connected socket costs nothing.
const maximumRetryMilliseconds = 30_000;
const firstRetryMilliseconds = 1_000;
const presenceTimeoutMilliseconds = 15_000;

/**
 * The one connection the app keeps to the room server for friends: being connected is being
 * online, the app's name and room are sent only when they change, and the server pushes the inbox
 * (requests, invitations, answers, friends) the moment it changes. Nothing is asked periodically.
 */
export const createSocialSocket = (
  url: string,
  deliver: (message: unknown) => void,
) => {
  let presence: SocialPresence = {
    displayName: '',
    participantId: null,
    roomId: null,
  };
  let revision = 0;
  const pending = new Map<
    number,
    {
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let retryMilliseconds = firstRetryMilliseconds;
  let stopped = true;

  const failPending = (message: string) => {
    for (const update of pending.values()) {
      clearTimeout(update.timer);
      update.reject(new Error(message));
    }
    pending.clear();
  };

  const connect = async (): Promise<void> => {
    retry = undefined;
    try {
      requireSecureRoomUrl(url);
    } catch {
      failPending('Presence connection is unavailable');
      deliver({ type: 'offline' });
      return;
    }
    let secret: string;
    try {
      if (!(await onlineAccountEnabled())) {
        failPending('Online account is disabled');
        deliver({ type: 'offline' });
        return;
      }
      secret = await deviceSecret();
    } catch {
      failPending('Account identity is unavailable');
      deliver({ type: 'offline' });
      if (!stopped) {
        retry = setTimeout(() => void connect(), retryMilliseconds);
        retryMilliseconds = Math.min(
          maximumRetryMilliseconds,
          retryMilliseconds * 2,
        );
      }
      return;
    }
    if (stopped) return;
    const opened = new WebSocket(url);
    socket = opened;
    opened.addEventListener('open', () => {
      retryMilliseconds = firstRetryMilliseconds;
      opened.send(JSON.stringify({ device: secret, ...presence, revision }));
    });
    opened.addEventListener('message', (event) => {
      if (socket !== opened) return;
      try {
        const message = JSON.parse(String(event.data)) as unknown;
        if (
          message &&
          typeof message === 'object' &&
          (message as { type?: unknown }).type === 'presenceAck' &&
          typeof (message as { revision?: unknown }).revision === 'number'
        ) {
          const acknowledged = (message as { revision: number }).revision;
          for (const [requested, update] of pending) {
            if (requested <= acknowledged) {
              pending.delete(requested);
              clearTimeout(update.timer);
              update.resolve();
            }
          }
          return;
        }
        deliver(message);
      } catch {
        // A message that is not JSON is not ours; the next one replaces the inbox anyway.
      }
    });
    opened.addEventListener('close', () => {
      if (socket !== opened) return;
      socket = undefined;
      failPending('Presence connection closed before acknowledgement');
      deliver({ type: 'offline' });
      if (stopped) return;
      retry = setTimeout(() => void connect(), retryMilliseconds);
      retryMilliseconds = Math.min(
        maximumRetryMilliseconds,
        retryMilliseconds * 2,
      );
    });
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      void connect();
    },
    /** Sent at once when connected, and with the greeting of every later connection. */
    setPresence(next: SocialPresence): Promise<void> {
      presence = next;
      revision += 1;
      const requested = revision;
      const applied = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requested);
          reject(new Error('Presence acknowledgement timed out'));
        }, presenceTimeoutMilliseconds);
        pending.set(requested, { resolve, reject, timer });
      });
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ ...presence, revision }));
      return applied;
    },
    stop(): void {
      stopped = true;
      clearTimeout(retry);
      failPending('Presence connection stopped');
      socket?.close();
      socket = undefined;
    },
  };
};
