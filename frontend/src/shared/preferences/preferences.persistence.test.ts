import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  defaultPreferences,
  loadPreferences,
  savePreferences,
} from './preferences';
import { clearStorage, storageKey } from '../storage/localStore';

beforeEach(() => {
  vi.useFakeTimers();
  clearStorage();
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('keeps slider updates immediately available while writing the latest preferences only once per burst', () => {
  const persist = vi.spyOn(Storage.prototype, 'setItem');
  const preferences = defaultPreferences();
  for (let index = 0; index < 100; index++)
    savePreferences({ ...preferences, voiceGain: index / 100 });
  expect(loadPreferences().voiceGain).toBe(0.99);
  expect(persist).not.toHaveBeenCalled();
  vi.advanceTimersByTime(250);
  expect(persist).toHaveBeenCalledOnce();
  expect(JSON.parse(persist.mock.calls[0]![1]).voiceGain).toBe(0.99);
});

it.each(['pagehide', 'beforeunload'])(
  'persists the last change before %s and cancels the deferred write',
  (event) => {
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    savePreferences({ ...defaultPreferences(), musicGain: 0.37 });
    expect(persist).not.toHaveBeenCalled();
    window.dispatchEvent(new Event(event));
    expect(persist).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(persist).toHaveBeenCalledOnce();
    expect(loadPreferences().musicGain).toBe(0.37);
  },
);

it('does not indefinitely postpone persistence during a sustained drag', () => {
  const preferences = defaultPreferences();
  savePreferences({ ...preferences, masterGain: 0.1 });
  vi.advanceTimersByTime(150);
  savePreferences({ ...preferences, masterGain: 0.7 });
  vi.advanceTimersByTime(100);
  const stored = JSON.parse(localStorage.getItem(storageKey('preferences'))!);
  expect(stored.masterGain).toBe(0.7);
});
