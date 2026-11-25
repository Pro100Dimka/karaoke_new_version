import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PlaybackSnapshot } from '../../contracts/models';
import { audioClient } from '../../services/audioClient';
import { useEditorPreview } from './useEditorPreview';

vi.mock('../../services/audioClient', () => ({
  audioClient: {
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    observeSnapshots: vi.fn(),
  },
}));
vi.mock('../../shared/errors', () => ({
  observeOperation: (_key: string, operation: Promise<unknown>) => operation,
}));

const snapshot = (positionSeconds: number) =>
  ({ state: 'playing', positionSeconds }) as PlaybackSnapshot;
const deferred = () => {
  let resolve!: (value: PlaybackSnapshot) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<PlaybackSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let emit: (snapshot: PlaybackSnapshot) => void;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(audioClient.play).mockResolvedValue(snapshot(0));
  vi.mocked(audioClient.observeSnapshots).mockImplementation((next) => {
    emit = next;
    return () => undefined;
  });
});

it('draws the latest seek immediately and keeps older clock samples from moving it backward', async () => {
  const first = deferred();
  const last = deferred();
  vi.mocked(audioClient.seek)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(last.promise);
  const failed = vi.fn();
  const { result } = renderHook(() => useEditorPreview(true, failed));
  await act(() => result.current.togglePlay());
  act(() => emit(snapshot(3)));
  let earlier!: Promise<void>;
  let latest!: Promise<void>;
  act(() => {
    earlier = result.current.seek(20);
    latest = result.current.seek(40);
  });
  expect.soft(result.current.position).toBe(40);
  act(() => emit(snapshot(3.1)));
  expect.soft(result.current.position).toBe(40);
  await act(async () => {
    first.resolve(snapshot(20));
    await earlier;
  });
  expect.soft(result.current.position).toBe(40);
  await act(async () => {
    last.resolve(snapshot(40.05));
    await latest;
  });
  expect(result.current.position).toBe(40.05);
  act(() => emit(snapshot(40.2)));
  expect(result.current.position).toBe(40.2);
});

it('rolls a failed newest seek back to the preceding acknowledged seek', async () => {
  const first = deferred();
  const last = deferred();
  vi.mocked(audioClient.seek)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(last.promise);
  const failed = vi.fn();
  const { result } = renderHook(() => useEditorPreview(true, failed));
  act(() => result.current.restore(snapshot(3)));
  let earlier!: Promise<void>;
  let latest!: Promise<void>;
  act(() => {
    earlier = result.current.seek(20);
    latest = result.current.seek(40);
  });
  await act(async () => {
    first.resolve(snapshot(20.05));
    await earlier;
  });
  expect.soft(result.current.position).toBe(40);
  await act(async () => {
    last.reject(new Error('Seek failed'));
    await latest;
  });
  expect(result.current.position).toBe(20.05);
});

it.each(['success', 'failure'] as const)(
  'keeps a gesture queued after song preparation until its %s',
  async (outcome) => {
    const pending = deferred();
    vi.mocked(audioClient.seek).mockReturnValue(pending.promise);
    const failed = vi.fn();
    const { result } = renderHook(() => useEditorPreview(true, failed));
    act(() => result.current.restore(snapshot(3)));
    let seeking!: Promise<void>;
    act(() => {
      seeking = result.current.seek(40);
    });
    // Saving replaces the guide while an explicit seek waits behind preparation.
    act(() => result.current.restore(snapshot(7)));
    expect.soft(result.current.position).toBe(40);
    await act(async () => {
      if (outcome === 'success') pending.resolve(snapshot(40.05));
      else pending.reject(new Error('Seek failed'));
      await seeking;
    });
    expect(result.current.position).toBe(outcome === 'success' ? 40.05 : 7);
  },
);

it.each(['finished', 'ready'] as const)(
  'keeps the %s transport transition while a seek target is pending',
  async (state) => {
    const pending = deferred();
    vi.mocked(audioClient.seek).mockReturnValue(pending.promise);
    const failed = vi.fn();
    const { result } = renderHook(() => useEditorPreview(true, failed));
    await act(() => result.current.togglePlay());
    act(() => emit(snapshot(3)));
    let seeking!: Promise<void>;
    act(() => {
      seeking = result.current.seek(40);
    });
    act(() => emit({ ...snapshot(60), state }));
    expect.soft(result.current.playing).toBe(false);
    expect.soft(result.current.position).toBe(40);
    await act(async () => {
      pending.reject(new Error('Seek failed'));
      await seeking;
    });
    expect(result.current.playing).toBe(false);
    expect(result.current.position).toBe(60);
  },
);

it.each(['playing', 'finished', 'ready'] as const)(
  'uses the final seek acknowledgement transport state %s without another notification',
  async (state) => {
    const pending = deferred();
    vi.mocked(audioClient.seek).mockReturnValue(pending.promise);
    const failed = vi.fn();
    const { result } = renderHook(() => useEditorPreview(true, failed));
    await act(() => result.current.togglePlay());
    let seeking!: Promise<void>;
    act(() => {
      seeking = result.current.seek(40);
    });
    if (state === 'playing')
      act(() => emit({ ...snapshot(60), state: 'finished' }));
    await act(async () => {
      pending.resolve({ ...snapshot(40), state });
      await seeking;
    });
    expect(result.current.playing).toBe(state === 'playing');
    expect(result.current.position).toBe(40);
  },
);
