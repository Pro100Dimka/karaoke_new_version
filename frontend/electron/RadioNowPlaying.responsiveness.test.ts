// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopShell } from './DesktopShell';
import { readStreamTitle, startRadioNowPlaying } from './RadioNowPlaying';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const metadataBlock = (text: string) => {
  const encoded = Buffer.from(text);
  const block = Buffer.alloc(Math.ceil(encoded.length / 16) * 16);
  encoded.copy(block);
  return block;
};

const streamedResponse = (chunks: Uint8Array[], metaint: number) => {
  const cancel = vi.fn();
  let index = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!);
        else controller.close();
      },
      cancel,
    }),
    { headers: { 'icy-metaint': String(metaint) } },
  );
  return { response, cancel };
};

it('skips the audio prefix without repeatedly copying the accumulated stream', async () => {
  const metaint = 65_536;
  const block = metadataBlock("StreamTitle='Singer - Пісня';");
  const audioChunks = Array.from({ length: metaint / 256 }, () =>
    new Uint8Array(256).fill(1),
  );
  const { response, cancel } = streamedResponse(
    [...audioChunks, Uint8Array.of(block.length / 16), block, Uint8Array.of(2)],
    metaint,
  );
  const concat = Buffer.concat;
  let copiedBytes = 0;
  vi.spyOn(Buffer, 'concat').mockImplementation((chunks, length) => {
    copiedBytes +=
      length ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    return concat(chunks, length);
  });

  expect(
    await readStreamTitle('https://radio.example/stream', async () => response),
  ).toEqual({ artist: 'Singer', title: 'Пісня' });
  expect(copiedBytes).toBeLessThanOrEqual(block.length * 2);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([1, 2, 7, 16, 257])(
  'reads a title split across %i-byte chunks and releases the stream',
  async (chunkSize) => {
    const metaint = 19;
    const block = metadataBlock("StreamTitle='Співак - Пісня 🎵';");
    const body = Buffer.concat([
      Buffer.alloc(metaint, 1),
      Uint8Array.of(block.length / 16),
      block,
      Buffer.alloc(1000, 2),
    ]);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < body.length; offset += chunkSize)
      chunks.push(body.subarray(offset, offset + chunkSize));
    const { response, cancel } = streamedResponse(chunks, metaint);

    expect(
      await readStreamTitle(
        'https://radio.example/stream',
        async () => response,
      ),
    ).toEqual({ artist: 'Співак', title: 'Пісня 🎵' });
    expect(cancel).toHaveBeenCalledOnce();
  },
);

it.each([
  ['an empty metadata block', [1, 0, 2]],
  ['a truncated audio prefix', []],
  ['a missing length byte', [1]],
  ['a truncated metadata block', [1, 1, 65]],
] as const)('returns no title for %s', async (_name, bytes) => {
  const { response } = streamedResponse([Uint8Array.from(bytes)], 1);
  expect(
    await readStreamTitle('https://radio.example/stream', async () => response),
  ).toBeNull();
});

it('reads the maximum ICY title block without including the following audio', async () => {
  const block = Buffer.alloc(255 * 16);
  block.write("StreamTitle='Singer - Title';");
  const { response } = streamedResponse(
    [
      Uint8Array.of(1, 255),
      block.subarray(0, 5),
      block.subarray(5),
      Uint8Array.of(2),
    ],
    1,
  );
  expect(
    await readStreamTitle('https://radio.example/stream', async () => response),
  ).toEqual({ artist: 'Singer', title: 'Title' });
});

const reportStation = (shell: DesktopShell, station: string, enabled = true) =>
  shell.report({
    screen: 'library',
    radio: {
      available: true,
      enabled,
      station,
      streamUrl: `https://radio.example/${station}`,
    },
  });

it('cancels obsolete metadata requests immediately when stations change or radio stops', async () => {
  const shell = new DesktopShell();
  const signals: AbortSignal[] = [];
  const fetchImpl = vi.fn<typeof fetch>((_url, options) => {
    const signal = options!.signal!;
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const polling = startRadioNowPlaying(shell, fetchImpl);
  try {
    for (let index = 0; index < 20; index += 1)
      reportStation(shell, `station-${index}`);
    expect(signals).toHaveLength(20);
    expect(signals.filter((signal) => !signal.aborted)).toHaveLength(1);

    reportStation(shell, 'station-19', false);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  } finally {
    polling.stop();
    await Promise.resolve();
  }
});

it('does not announce a delayed result after the integration stops', async () => {
  const shell = new DesktopShell();
  const announce = vi.fn();
  shell.connect(announce);
  const block = metadataBlock("StreamTitle='Singer - Old station';");
  const { response } = streamedResponse(
    [Uint8Array.of(1, block.length / 16), block],
    1,
  );
  let resolve!: (value: Response) => void;
  const request = new Promise<Response>((done) => {
    resolve = done;
  });
  const polling = startRadioNowPlaying(shell, async () => request);
  reportStation(shell, 'first');
  polling.stop();
  announce.mockClear();
  resolve(response);
  await new Promise<void>((done) => setImmediate(done));

  expect(announce).not.toHaveBeenCalled();
});

it('keeps one poll in flight and resumes polling after it settles', async () => {
  vi.useFakeTimers();
  const shell = new DesktopShell();
  const announce = vi.fn();
  shell.connect(announce);
  const block = metadataBlock("StreamTitle='Singer - Current station';");
  const { response } = streamedResponse(
    [Uint8Array.of(1, block.length / 16), block],
    1,
  );
  let resolve!: (value: Response) => void;
  const request = new Promise<Response>((done) => {
    resolve = done;
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => request);
  const polling = startRadioNowPlaying(shell, fetchImpl);
  try {
    reportStation(shell, 'current');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchImpl).toHaveBeenCalledOnce();
    resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(announce).toHaveBeenLastCalledWith({
      type: 'radioTrack',
      artist: 'Singer',
      title: 'Current station',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    polling.stop();
  }
});
