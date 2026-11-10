import { describe, expect, it } from 'vitest';
import type { RecordingDto } from '../../../../contracts/models';
import { numberTakes } from './takeNames';

const take = (id: string, createdAt: string, sourceRecordingId?: string) =>
  ({ id, createdAt, sourceRecordingId }) as RecordingDto;

describe('numberTakes', () => {
  it('numbers originals in chronological order, excluding mastered versions', () => {
    const recordings = [
      take('later', '2026-11-01T12:00:00Z'),
      take('master', '2026-11-01T11:00:00Z', 'earlier'),
      take('earlier', '2026-11-01T09:00:00Z'),
    ];
    expect([...numberTakes(recordings)]).toEqual([
      ['earlier', 1],
      ['later', 2],
    ]);
    expect(recordings.map(({ id }) => id)).toEqual(['later', 'master', 'earlier']);
  });

  it('preserves id tie breaking for equal dates', () => {
    expect([...numberTakes([take('b', '2026-11-01'), take('a', '2026-11-01')])]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('supports empty lists', () => {
    expect(numberTakes([]).size).toBe(0);
  });
});
