import { act, render, screen } from '@testing-library/react';
import { createContext } from 'react';
import { runInAction } from 'mobx';
import { beforeEach, expect, it, vi } from 'vitest';
import { store } from '../../providers/store';
import { KaraokeHost } from './KaraokeHost';
import { useKaraokeTv, type KaraokeTv } from './tv/karaokeTv';

const navigation = vi.hoisted(() => ({
  pathname: '/karaoke/first',
  params: { songId: 'first' },
  navigate: vi.fn(),
}));
let tv: KaraokeTv;
let finish: (songId: string, takeId?: string) => void;
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => navigation,
}));
vi.mock('../../app/desktop/shellBus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/desktop/shellBus')>()),
  karaokeOnTv: { set: vi.fn() },
  useDisplayCount: () => 2,
}));
vi.mock('./KaraokePage', () => ({
  KaraokeSlotContext: createContext(() => {}),
  KaraokeScreen: ({
    songId,
    onFinished,
  }: {
    songId: string;
    onFinished(songId: string, takeId?: string): void;
  }) => {
    finish = onFinished;
    return <div data-testid="playing-song">{songId}</div>;
  },
}));
vi.mock('./tv/useTvWindow', () => {
  const open = () => ({});
  const close = () => {};
  return { useTvWindow: () => ({ screen: null, open, close }) };
});

const Controls = () => {
  tv = useKaraokeTv()!;
  return null;
};
beforeEach(() => {
  vi.clearAllMocks();
  navigation.pathname = '/karaoke/first';
  navigation.params = { songId: 'first' };
  navigation.navigate.mockImplementation((path: string) => {
    navigation.pathname = path;
    navigation.params = {
      songId: path.startsWith('/karaoke/') ? path.slice(9) : '',
    };
  });
  runInAction(() => {
    store.online.room = null;
    store.playback.returned = null;
    store.startPlaylist('Set', ['first', 'second']);
  });
});

it('continues the local playlist on the TV and finishes it after the last song', () => {
  render(
    <KaraokeHost>
      <Controls />
    </KaraokeHost>,
  );
  act(() => tv.send());
  expect(tv.active).toBe(true);
  expect(screen.getByTestId('playing-song')).toHaveTextContent('first');

  act(() => finish('first', 'first-take'));
  expect(tv.active).toBe(true);
  expect(screen.getByTestId('playing-song')).toHaveTextContent('second');
  expect(store.playback.playlist?.index).toBe(1);
  expect(store.playback.returned?.analysisFor).toBe('first-take');

  act(() => finish('second', 'second-take'));
  expect(tv.active).toBe(false);
  expect(store.playback.playlist).toBeNull();
  expect(store.playback.returned?.analysisFor).toBe('second-take');
});

it('honours an explicit TV queue and clears the displaced automatic playlist', () => {
  render(
    <KaraokeHost>
      <Controls />
    </KaraokeHost>,
  );
  act(() => tv.send());
  act(() => tv.play({ id: 'manual', title: 'Manual' }, 'next'));
  act(() => finish('first'));
  expect(tv.active).toBe(true);
  expect(screen.getByTestId('playing-song')).toHaveTextContent('manual');
  expect(store.playback.playlist).toBeNull();
  act(() => finish('manual'));
  expect(tv.active).toBe(false);
});
