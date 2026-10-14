import type { DesktopShell, ShellStatus } from "./DesktopShell";

/** How often the playing station is asked what it plays. */
const pollMilliseconds = 20_000;
/** The ICY title block is at most 255 × 16 bytes after `icy-metaint` bytes of audio. */
const maxMetadataBytes = 255 * 16;

export interface RadioTrack {
  title: string;
  artist?: string;
}

/**
 * "Artist - Title" as Icecast stations send it in `StreamTitle='…';`, or null when there is none
 * (station jingles and breaks often send an empty title).
 */
export const radioTrackFrom = (metadata: string): RadioTrack | null => {
  const streamTitle = /StreamTitle='(.*?)';/s.exec(metadata)?.[1]?.trim();
  if (!streamTitle) return null;
  const split = streamTitle.indexOf(" - ");
  if (split <= 0) return { title: streamTitle.slice(0, 200) };
  const artist = streamTitle.slice(0, split).trim().slice(0, 200);
  const title = streamTitle.slice(split + 3).trim().slice(0, 200);
  return title ? { title, ...(artist ? { artist } : {}) } : { title: artist };
};

/**
 * What a station plays now: reads the stream only up to its first title block (tens of KB, not
 * the audio itself; AudioService plays that), then lets it go.
 */
export const readStreamTitle = async (
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RadioTrack | null> => {
  const response = await fetchImpl(url, {
    headers: { "Icy-MetaData": "1", "User-Agent": "AD-Voice" },
    signal: AbortSignal.timeout(15_000),
  });
  const metaint = Number(response.headers.get("icy-metaint"));
  if (!response.ok || !response.body || !Number.isInteger(metaint) || metaint <= 0) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0);
  try {
    while (buffer.length < metaint + 1 + maxMetadataBytes) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      if (buffer.length <= metaint) continue;
      const length = buffer[metaint]! * 16;
      if (buffer.length < metaint + 1 + length) continue;
      return radioTrackFrom(buffer.subarray(metaint + 1, metaint + 1 + length).toString("utf8"));
    }
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const playing = (status: ShellStatus): string | null =>
  status.radio.enabled && status.radio.available && status.radio.streamUrl ? status.radio.streamUrl : null;

/**
 * Tells the interface what the radio plays (artist and title), for its volume popup, the tray and
 * Discord: asks the playing station every 20 s while the radio plays, and clears it when it stops.
 */
export const startRadioNowPlaying = (shell: DesktopShell, fetchImpl: typeof fetch = fetch) => {
  let url: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let last = "";
  let generation = 0;

  const announce = (track: RadioTrack | null) => {
    const key = JSON.stringify(track);
    if (key === last) return;
    last = key;
    shell.send(track ? { type: "radioTrack", ...track } : { type: "radioTrack" });
  };

  const poll = async (current: number, station: string) => {
    try {
      const track = await readStreamTitle(station, fetchImpl);
      if (current === generation) announce(track);
    } catch {
      // Offline or the station does not answer: the title stays as it was until the next ask.
    }
  };

  const follow = (status: ShellStatus) => {
    const next = playing(status);
    if (next === url) return;
    url = next;
    generation += 1;
    clearInterval(timer);
    timer = undefined;
    announce(null);
    if (!next) return;
    const current = generation;
    void poll(current, next);
    timer = setInterval(() => void poll(current, next), pollMilliseconds);
    timer.unref();
  };

  const unsubscribe = shell.onStatus(follow);
  return {
    stop(): void {
      unsubscribe();
      clearInterval(timer);
    },
  };
};
