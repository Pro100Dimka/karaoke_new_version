import type { DesktopShell, ShellStatus } from './DesktopShell';

/** How often the playing station is asked what it plays. */
const pollMilliseconds = 20_000;

interface RadioTrack {
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
  const split = streamTitle.indexOf(' - ');
  if (split <= 0) return { title: streamTitle.slice(0, 200) };
  const artist = streamTitle.slice(0, split).trim().slice(0, 200);
  const title = streamTitle
    .slice(split + 3)
    .trim()
    .slice(0, 200);
  return title ? { title, ...(artist ? { artist } : {}) } : { title: artist };
};

/**
 * What a station plays now: reads the stream only up to its first title block (tens of KB, not
 * the audio itself; AudioService plays that), then lets it go.
 */
export const readStreamTitle = async (
  url: string,
  fetchImpl: typeof fetch = fetch,
  stop?: AbortSignal,
): Promise<RadioTrack | null> => {
  const response = await fetchImpl(url, {
    headers: { 'Icy-MetaData': '1', 'User-Agent': 'AD-Voice' },
    signal: stop
      ? AbortSignal.any([stop, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  const metaint = Number(response.headers.get('icy-metaint'));
  if (
    !response.ok ||
    !response.body ||
    !Number.isInteger(metaint) ||
    metaint <= 0
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  let audioRemaining = metaint;
  let metadata: Buffer | undefined;
  let written = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return null;
      // The audio is played elsewhere. Discard its prefix without retaining or recopying it.
      let offset = Math.min(audioRemaining, value.length);
      audioRemaining -= offset;
      if (audioRemaining || offset === value.length) continue;
      if (!metadata) {
        // One length byte bounds this allocation to 255 × 16 bytes, regardless of the prefix.
        const length = value[offset++]! * 16;
        if (!length) return null;
        metadata = Buffer.allocUnsafe(length);
      }
      const count = Math.min(metadata.length - written, value.length - offset);
      metadata.set(value.subarray(offset, offset + count), written);
      written += count;
      if (written === metadata.length)
        return radioTrackFrom(metadata.toString('utf8'));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const playing = (status: ShellStatus): string | null =>
  status.radio.enabled && status.radio.available && status.radio.streamUrl
    ? status.radio.streamUrl
    : null;

/**
 * Tells the interface what the radio plays (artist and title), for its volume popup, the tray and
 * Discord: asks the playing station every 20 s while the radio plays, and clears it when it stops.
 */
export const startRadioNowPlaying = (
  shell: DesktopShell,
  fetchImpl: typeof fetch = fetch,
) => {
  let url: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let last = '';
  let generation = 0;
  let inFlight: AbortController | undefined;

  const announce = (track: RadioTrack | null) => {
    const key = JSON.stringify(track);
    if (key === last) return;
    last = key;
    shell.send(
      track ? { type: 'radioTrack', ...track } : { type: 'radioTrack' },
    );
  };

  const poll = async (current: number, station: string) => {
    if (current !== generation || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    try {
      const track = await readStreamTitle(
        station,
        fetchImpl,
        controller.signal,
      );
      if (current === generation && !controller.signal.aborted) announce(track);
    } catch {
      // Offline or the station does not answer: the title stays as it was until the next ask.
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  };

  const follow = (status: ShellStatus) => {
    const next = playing(status);
    if (next === url) return;
    url = next;
    generation += 1;
    inFlight?.abort();
    inFlight = undefined;
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
      generation += 1;
      inFlight?.abort();
      inFlight = undefined;
      clearInterval(timer);
    },
  };
};
