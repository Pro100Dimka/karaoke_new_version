import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe('room audio alignment', () => {
  it('finds the sample offset between two rendered signals', async () => {
    const { estimateOffsetMs } = await import('./room-audio-alignment.mjs');
    const source = Array.from({ length: 200 }, (_, index) =>
      Math.sin(index / 7),
    );
    const delayed = [...Array(4).fill(0), ...source.slice(0, -4)];
    expect(estimateOffsetMs(source, delayed, 1000).offsetMs).toBe(4);
  });

  it.each([
    'room-audio-alignment.mjs', 'network-vocal-process-test.mjs',
    'network-resilience-process-test.mjs',
  ])(
    '%s rejects empty audio without hanging', (file) => {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        const helper = file === 'room-audio-alignment.mjs'
          ? source.replace('export function', 'function')
          : source.match(/^const correlate = [\s\S]*?^};/m)?.[0];
        expect(helper, file).toBeTruthy();
        const name = file === 'room-audio-alignment.mjs' ? 'estimateOffsetMs' : 'correlate';
        for (const [a, b] of [[[], []], [[1, 2, 3], []], [[], [1, 2, 3]]]) {
          expect(() => runInNewContext(
            `${helper}\n${name}(left, right, 1000)`, { left: a, right: b }, { timeout: 200 },
          ), file).toThrow(/nonempty signals/);
        }
    },
  );
});
