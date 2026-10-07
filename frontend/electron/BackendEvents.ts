import type { BackendEndpoint } from "./BackendEndpoint";

const retryMilliseconds = 1000;
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface BackendEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** Extracts the JSON payload of each complete Server-Sent Events message; heartbeats carry none. */
export const parseServerSentEvents = (
  buffer: string,
): { events: BackendEvent[]; rest: string } => {
  const messages = buffer.split(/\r?\n\r?\n/);
  const rest = messages.pop() ?? "";
  const events: BackendEvent[] = [];
  for (const message of messages) {
    const data = message
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const value = JSON.parse(data) as unknown;
      if (
        value &&
        typeof value === "object" &&
        typeof (value as BackendEvent).type === "string"
      )
        events.push(value as BackendEvent);
    } catch {
      // A malformed message is skipped; the next one is independent.
    }
  }
  return { events, rest };
};

/**
 * Keeps one Server-Sent Events stream open to the local backend and hands every event to `emit`.
 * Each (re)connection is announced as `{ type: "connected" }`, because events that happened while the
 * stream was down (backend restart, start-up) are lost and listeners must refresh what they show.
 */
export const streamBackendEvents = (
  endpoint: BackendEndpoint,
  emit: (event: BackendEvent) => void,
  stop: AbortSignal,
): void => {
  void (async () => {
    while (!stop.aborted) {
      const backend = endpoint.current();
      if (!backend) {
        await wait(retryMilliseconds);
        continue;
      }
      try {
        const signal = AbortSignal.any([stop, backend.lifetime]);
        const response = await fetch(`${backend.origin}/events`, {
          signal,
          headers: { accept: "text/event-stream" },
        });
        if (!response.ok || !response.body)
          throw new Error(`Backend events: HTTP ${response.status}`);
        emit({ type: "connected" });
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          const parsed = parseServerSentEvents(
            buffer + decoder.decode(chunk as Uint8Array, { stream: true }),
          );
          buffer = parsed.rest;
          for (const event of parsed.events) emit(event);
        }
      } catch {
        // The backend stopped or restarted; the loop reconnects to whichever process runs next.
      }
      if (!stop.aborted) await wait(retryMilliseconds);
    }
  })();
};
