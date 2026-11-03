import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationsProvider, useNotify } from './notifications';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('sounds each notice intent once while allowing an existing participant chime to own its notice', () => {
  vi.useFakeTimers();
  const played: string[] = [];
  vi.stubGlobal(
    'Audio',
    class {
      volume = 1;
      constructor(private url: string) {}
      play() {
        played.push(this.url);
        return Promise.resolve();
      }
      pause() {}
    },
  );
  const { result } = renderHook(useNotify, { wrapper: NotificationsProvider });
  act(() => result.current('Saved', 'success'));
  expect(played).toHaveLength(1);
  act(() => result.current('Joined', 'info', { silent: true }));
  expect(played).toHaveLength(1);
});
