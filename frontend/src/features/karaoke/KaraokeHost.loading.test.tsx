import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { expect, it, vi } from 'vitest';
import { KaraokeHost } from './KaraokeHost';
import { useKaraokeTv, type KaraokeTv } from './tv/karaokeTv';

const probe = vi.hoisted(() => ({
  loaded: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
  navigation: {
    pathname: '/',
    params: { songId: '' },
    navigate: vi.fn(),
  },
}));
vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => probe.navigation,
}));
vi.mock('../../app/desktop/shellBus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/desktop/shellBus')>()),
  karaokeOnTv: { set: vi.fn() },
  useDisplayCount: () => 2,
}));
vi.mock('./KaraokePage', () => {
  probe.loaded();
  return {
    KaraokeScreen: ({ songId }: { songId: string }) => {
      useEffect(() => {
        probe.mounted(songId);
        return () => probe.unmounted(songId);
      }, []);
      return <div data-testid="playing-song">{songId}</div>;
    },
  };
});
vi.mock('./tv/useTvWindow', () => {
  const open = () => ({});
  const close = () => undefined;
  return { useTvWindow: () => ({ screen: null, open, close }) };
});

let tv: KaraokeTv;
const Controls = () => {
  tv = useKaraokeTv()!;
  return null;
};

it('loads the karaoke screen on first use and keeps its session when moving to the TV and back', async () => {
  const navigate = (path: string) => {
    probe.navigation.pathname = path;
    probe.navigation.params = {
      songId: path.startsWith('/karaoke/') ? path.slice(9) : '',
    };
  };
  probe.navigation.navigate.mockImplementation(navigate);
  const view = () => (
    <KaraokeHost>
      <Controls />
    </KaraokeHost>
  );
  const { rerender, unmount } = render(view());
  expect(probe.loaded).not.toHaveBeenCalled();
  expect(screen.queryByTestId('playing-song')).toBeNull();

  navigate('/karaoke/first');
  rerender(view());
  expect(await screen.findByTestId('playing-song')).toHaveTextContent('first');
  expect(probe.loaded).toHaveBeenCalledTimes(1);
  expect(probe.mounted).toHaveBeenCalledTimes(1);

  act(() => tv.send());
  expect(tv.active).toBe(true);
  expect(screen.getByTestId('playing-song')).toHaveTextContent('first');
  act(() => tv.bringBack());
  rerender(view());
  expect(tv.active).toBe(false);
  expect(screen.getByTestId('playing-song')).toHaveTextContent('first');
  expect(probe.loaded).toHaveBeenCalledTimes(1);
  expect(probe.mounted).toHaveBeenCalledTimes(1);
  expect(probe.unmounted).not.toHaveBeenCalled();
  unmount();
  expect(probe.unmounted).toHaveBeenCalledTimes(1);
});
