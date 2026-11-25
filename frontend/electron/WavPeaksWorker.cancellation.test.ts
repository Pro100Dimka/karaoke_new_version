// @vitest-environment node
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';
import { expect, it, vi } from 'vitest';

const wav = (pcm: Buffer) => {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

it('interrupts an active WAV read and removes abandoned queued jobs before the next preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wave-worker-cancel-'));
  const source = path.join(root, 'long.wav');
  const next = path.join(root, 'next.wav');
  const compiled = await build({
    entryPoints: [path.resolve('electron/WavPeaksWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const script = path.join(root, 'worker.cjs');
  // Hold one real PCM read, then let normal worker messages cancel it. A separate
  // test-control port keeps the production protocol and its ordering untouched.
  const barrier = `
(() => {
  const { parentPort, workerData } = require('node:worker_threads');
  const fs = require('node:fs/promises');
  const originalOpen = fs.open;
  let held = false;
  let resume;
  workerData.control.on('message', () => resume?.());
  parentPort.on('message', message => {
    if (message.id === 2002) workerData.control.postMessage('queued');
  });
  fs.open = async (...args) => {
    const file = await originalOpen(...args);
    workerData.control.postMessage('opened:' + args[0]);
    const originalClose = file.close.bind(file);
    file.close = async () => {
      await originalClose();
      workerData.control.postMessage('closed:' + args[0]);
    };
    const originalRead = file.read.bind(file);
    file.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      if (!held && args[0] === workerData.source && readArgs[2] >= 1048576) {
        held = true;
        await new Promise(resolve => {
          resume = resolve;
          workerData.control.postMessage('reading');
        });
      }
      return result;
    };
    return file;
  };
})();
`;
  await writeFile(source, wav(Buffer.alloc(2 << 20)));
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(16384, 0);
  pcm.writeInt16LE(-32768, 2);
  await writeFile(next, wav(pcm));
  await writeFile(script, barrier + compiled.outputFiles[0]!.text);
  const { port1, port2 } = new MessageChannel();
  const control: string[] = [];
  port1.on('message', (message: string) => control.push(message));
  const worker = new Worker(script, {
    workerData: { source, control: port2 },
    transferList: [port2],
  });
  const replies: Array<{ id: number; name?: string; peaks?: number[] }> = [];
  const errors: Error[] = [];
  worker.on('message', (message) => replies.push(message));
  worker.on('error', (error) => errors.push(error));
  try {
    worker.postMessage({ id: 1, filePath: source, bins: 2 });
    await vi.waitFor(() => expect(control).toContain('reading'), {
      timeout: 5000,
    });
    for (let id = 2; id < 2002; id += 1) {
      worker.postMessage({ id, filePath: source, bins: 2 });
      worker.postMessage({ id, cancel: true });
    }
    worker.postMessage({ id: 1, cancel: true });
    worker.postMessage({ id: 2002, filePath: next, bins: 2 });
    await vi.waitFor(() => expect(control).toContain('queued'), {
      timeout: 5000,
    });
    port1.postMessage('resume');
    await vi.waitFor(
      () => expect(replies.some(({ id }) => id === 2002)).toBe(true),
      { timeout: 5000 },
    );
    await vi.waitFor(() =>
      expect(control.filter((item) => item.startsWith('closed:'))).toHaveLength(
        2,
      ),
    );
    expect(control.filter((item) => item.startsWith('opened:'))).toEqual([
      `opened:${source}`,
      `opened:${next}`,
    ]);
    expect(errors).toEqual([]);
    expect(replies.map(({ id }) => id)).toEqual([1, 2002]);
    expect(replies[0]).toMatchObject({ id: 1, name: 'AbortError' });
    expect(replies[1]).toEqual({ id: 2002, peaks: [0.5, 1] });
  } finally {
    await worker.terminate();
    port1.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
