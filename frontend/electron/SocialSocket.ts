import { deviceSecret } from "./SocialIdentity";

export interface SocialPresence {
  displayName: string;
  participantId: string | null;
  roomId: string | null;
}

// Reconnecting after the server went away backs off to this; a connected socket costs nothing.
const maximumRetryMilliseconds = 30_000;
const firstRetryMilliseconds = 1_000;

/**
 * The one connection the app keeps to the room server for friends: being connected is being
 * online, the app's name and room are sent only when they change, and the server pushes the inbox
 * (requests, invitations, answers, friends) the moment it changes. Nothing is asked periodically.
 */
export const createSocialSocket = (url: string, deliver: (message: unknown) => void) => {
  let presence: SocialPresence = { displayName: "", participantId: null, roomId: null };
  let revision = 0;
  const pending = new Map<number, () => void>();
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let retryMilliseconds = firstRetryMilliseconds;
  let stopped = true;

  const connect = async (): Promise<void> => {
    retry = undefined;
    const secret = await deviceSecret();
    if (stopped) return;
    const opened = new WebSocket(url);
    socket = opened;
    opened.addEventListener("open", () => {
      retryMilliseconds = firstRetryMilliseconds;
      opened.send(JSON.stringify({ device: secret, ...presence, revision }));
    });
    opened.addEventListener("message", event => {
      try {
        const message = JSON.parse(String(event.data)) as unknown;
        if (message && typeof message === "object" &&
            (message as { type?: unknown }).type === "presenceAck" &&
            typeof (message as { revision?: unknown }).revision === "number") {
          const acknowledged = (message as { revision: number }).revision;
          for (const [requested, resolve] of pending) {
            if (requested <= acknowledged) {
              pending.delete(requested);
              resolve();
            }
          }
          return;
        }
        deliver(message);
      } catch {
        // A message that is not JSON is not ours; the next one replaces the inbox anyway.
      }
    });
    opened.addEventListener("close", () => {
      if (socket !== opened) return;
      socket = undefined;
      deliver({ type: "offline" });
      if (stopped) return;
      retry = setTimeout(() => void connect(), retryMilliseconds);
      retryMilliseconds = Math.min(maximumRetryMilliseconds, retryMilliseconds * 2);
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
      const applied = new Promise<void>(resolve => pending.set(revision, resolve));
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...presence, revision }));
      return applied;
    },
    stop(): void {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
      socket = undefined;
    },
  };
};
