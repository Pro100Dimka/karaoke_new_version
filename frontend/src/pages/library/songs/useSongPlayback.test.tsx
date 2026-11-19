import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../contracts/models';
import type { useRoomLibrary } from './useRoomLibrary';
import { store } from '../../../providers/store';
import { curtainMilliseconds, useSongPlayback } from './useSongActions';

vi.mock('@neo-ui-kit/react', () => ({
  tr: (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('../../../components/api-service', () => ({ refreshSongs: vi.fn() }));
vi.mock('../../../providers/store', () => ({
  store: { application: { localProcessing: false }, prepareKaraoke: vi.fn() },
}));
vi.mock('../../../providers/dialog', () => ({ ask: vi.fn() }));
vi.mock('../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../../services/pythonClient', () => ({ pythonClient: {} }));
vi.mock('../../../services/audioClient', () => ({ audioClient: {} }));
vi.mock('../../../services/desktopClient', () => ({ desktopClient: {} }));
vi.mock('./lastPlayed', () => ({ markPlayed: vi.fn() }));

const song = { id: 'song' } as SongDto;
const roomLibrary = { room: null } as ReturnType<typeof useRoomLibrary>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  store.application.localProcessing = false;
});
afterEach(() => vi.useRealTimers());

it('cancels a delayed launch when the library is left', async () => {
  const navigate = vi.fn();
  const { result, unmount } = renderHook(() =>
    useSongPlayback({ roomLibrary, navigate }),
  );
  act(() => result.current.playSong(song));
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(curtainMilliseconds));
  expect(navigate).not.toHaveBeenCalled();
  expect(store.prepareKaraoke).not.toHaveBeenCalled();
});

it('starts a single transition when play is clicked repeatedly', async () => {
  const navigate = vi.fn();
  const { result } = renderHook(() =>
    useSongPlayback({ roomLibrary, navigate }),
  );
  act(() => {
    result.current.playSong(song);
    result.current.playSong({ ...song, id: 'other' });
  });
  await act(() => vi.advanceTimersByTimeAsync(curtainMilliseconds));
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith('/karaoke/song');
  expect(store.prepareKaraoke).toHaveBeenCalledTimes(1);
});

it('allows another attempt after processing cancels a pending launch', async () => {
  const navigate = vi.fn();
  const { result, rerender } = renderHook(() =>
    useSongPlayback({ roomLibrary, navigate }),
  );
  act(() => result.current.playSong(song));
  store.application.localProcessing = true;
  rerender();
  await act(() => vi.advanceTimersByTimeAsync(curtainMilliseconds));
  expect(navigate).not.toHaveBeenCalled();
  expect(result.current.launching).toBe(false);

  store.application.localProcessing = false;
  rerender();
  act(() => result.current.playSong(song, true));
  await act(() => vi.advanceTimersByTimeAsync(curtainMilliseconds));
  expect(store.prepareKaraoke).toHaveBeenCalledWith('song', 'Rehearsal');
  expect(navigate).toHaveBeenCalledTimes(1);
});
