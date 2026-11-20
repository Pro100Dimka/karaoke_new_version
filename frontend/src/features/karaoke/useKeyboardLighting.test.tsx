import { act, renderHook } from '@testing-library/react';
import { observable, runInAction } from 'mobx';
import { afterEach, expect, it, vi } from 'vitest';
import { keyboardLightingClient } from '../../services/keyboardLightingClient';
import type { KeyboardLightingPreferences } from '../../shared/preferences/preferences';
import { useKeyboardLighting } from './useKeyboardLighting';

const theme: KeyboardLightingPreferences = {
  enabled: true,
  mode: 'theme',
  brightness: 55,
  sensitivity: 50,
};

afterEach(() => vi.restoreAllMocks());

it('applies static theme once without observing the live MobX song clock', () => {
  const apply = vi.spyOn(keyboardLightingClient, 'apply').mockResolvedValue();
  const clock = observable({ seconds: 0 });
  const position = vi.fn(() => clock.seconds);
  const view = renderHook(() =>
    useKeyboardLighting(theme, 'green', position, true),
  );
  for (let frame = 1; frame <= 240; frame++)
    act(() => runInAction(() => (clock.seconds = frame / 60)));
  expect(apply).toHaveBeenCalledOnce();
  expect(position).not.toHaveBeenCalled();
  view.unmount();
  act(() => runInAction(() => (clock.seconds = 8)));
  expect(apply).toHaveBeenCalledOnce();
});

it('does not restart the static theme effect for numeric playback positions or play/pause', () => {
  const apply = vi.spyOn(keyboardLightingClient, 'apply').mockResolvedValue();
  const { rerender } = renderHook(
    ({ seconds, playing }) =>
      useKeyboardLighting(theme, 'green', seconds, playing),
    { initialProps: { seconds: 0, playing: true } },
  );
  for (let frame = 1; frame <= 240; frame++)
    rerender({ seconds: frame / 60, playing: frame < 120 });
  expect(apply).toHaveBeenCalledOnce();
});

it('keeps music pulses at every half second, pauses to theme and resumes at the latest clock', () => {
  const apply = vi.spyOn(keyboardLightingClient, 'apply').mockResolvedValue();
  const clock = observable({ seconds: 0 });
  const position = () => clock.seconds;
  const preferences = { ...theme, mode: 'music' as const };
  const { rerender, unmount } = renderHook(
    ({ playing }) =>
      useKeyboardLighting(preferences, 'green', position, playing),
    { initialProps: { playing: true } },
  );
  const move = (seconds: number) =>
    act(() => runInAction(() => (clock.seconds = seconds)));
  move(0.49);
  expect(apply).toHaveBeenCalledOnce();
  move(0.5);
  move(1);
  expect(apply.mock.calls.map(([, , seconds]) => seconds)).toEqual([0, 0.5, 1]);
  rerender({ playing: false });
  expect(apply.mock.calls.at(-1)?.[0].mode).toBe('theme');
  const pausedCalls = apply.mock.calls.length;
  move(1.5);
  move(2.25);
  expect(apply).toHaveBeenCalledTimes(pausedCalls);
  rerender({ playing: true });
  expect(apply).toHaveBeenLastCalledWith(preferences, 'green', 2);
  move(2.5);
  expect(apply).toHaveBeenLastCalledWith(preferences, 'green', 2.5);
  unmount();
  expect(apply.mock.calls.at(-1)?.[0].mode).toBe('theme');
  const closedCalls = apply.mock.calls.length;
  move(3);
  expect(apply).toHaveBeenCalledTimes(closedCalls);
});

it('still applies changed static preferences and never starts a disabled clock subscription', () => {
  const apply = vi.spyOn(keyboardLightingClient, 'apply').mockResolvedValue();
  const position = vi.fn(() => 100);
  const { rerender } = renderHook(
    ({ preferences }) =>
      useKeyboardLighting(preferences, 'green', position, true),
    { initialProps: { preferences: { ...theme, enabled: false } } },
  );
  expect(apply).not.toHaveBeenCalled();
  expect(position).not.toHaveBeenCalled();
  rerender({ preferences: theme });
  expect(apply).toHaveBeenCalledOnce();
  rerender({ preferences: { ...theme, brightness: 70 } });
  expect(apply.mock.calls.at(-1)?.[0].brightness).toBe(70);
});
