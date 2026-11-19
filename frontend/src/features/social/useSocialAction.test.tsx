import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useSocialAction } from './useSocialAction';

const notify = vi.hoisted(() => vi.fn());
vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('../../providers/notifications', () => ({ useNotify: () => notify }));
beforeEach(() => vi.clearAllMocks());

it('keeps one friends action pending and allows the next action after completion', async () => {
  let finish!: () => void;
  const first = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const second = vi.fn(async () => {});
  const { result } = renderHook(useSocialAction);
  let pending!: Promise<boolean>;
  let duplicate!: Promise<boolean>;
  act(() => {
    pending = result.current.run(first);
    duplicate = result.current.run(second);
  });
  try {
    expect(second).not.toHaveBeenCalled();
    expect(await duplicate).toBe(false);
    expect(result.current.busy).toBe(true);
  } finally {
    await act(async () => {
      finish();
      await pending;
    });
  }
  expect(result.current.busy).toBe(false);
  await act(async () => {
    expect(await result.current.run(second)).toBe(true);
  });
  expect(second).toHaveBeenCalledTimes(1);
});

it('releases a failed action so the user can retry', async () => {
  const action = vi
    .fn()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(undefined);
  const { result } = renderHook(useSocialAction);
  await act(async () => {
    expect(await result.current.run(action)).toBe(false);
  });
  expect(result.current.busy).toBe(false);
  expect(notify).toHaveBeenCalledTimes(1);
  await act(async () => {
    expect(await result.current.run(action)).toBe(true);
  });
  expect(action).toHaveBeenCalledTimes(2);
});
