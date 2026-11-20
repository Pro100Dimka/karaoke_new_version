import { tr } from '@neo-ui-kit/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createTrustedIpc } from '../../electron/TrustedIpc';
import ErrorFallback from './error-boundary';
import Localization from './localization';

const desktop = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  minimize: vi.fn(async () => undefined),
  toggleFullscreen: vi.fn(async () => true),
  isFullscreen: vi.fn(async () => false),
  isMaximized: vi.fn(async () => false),
  onWindowState: vi.fn(() => () => undefined),
}));
vi.mock('../services/desktopClient', () => ({ desktopClient: desktop }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const locations = [
  'file:///D:/A%26D%20Voice/frontend/dist/index.html#/editor/song-1',
  'http://127.0.0.1:5173/?profile=local#/editor/song-1',
];

const observeNavigation = (href: string) => {
  const current = new URL(href);
  const destinations: string[] = [];
  const reload = vi.fn(() => destinations.push(current.href));
  vi.stubGlobal('location', {
    get href() {
      return current.href;
    },
    get hash() {
      return current.hash;
    },
    set hash(value: string) {
      current.hash = value;
    },
    assign: (value: string) => destinations.push(new URL(value, current).href),
    reload,
  });
  return { destinations, reload };
};

const renderFailure = () =>
  render(
    <Localization>
      <ErrorFallback
        error={new Error('The editor could not render')}
        resetErrorBoundary={vi.fn()}
      />
    </Localization>,
  );

it.each(locations)(
  'returns home by reloading the trusted application entry from %s',
  async (href) => {
    vi.stubEnv('BASE_URL', './');
    const navigation = observeNavigation(href);
    const trustedIpc = createTrustedIpc(() => null, href);
    renderFailure();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: tr('errorBoundary.home') }),
      );
    });

    const expected = new URL(href);
    expected.hash = '/';
    expect(navigation.destinations).toEqual([expected.href]);
    expect(navigation.destinations.map(trustedIpc.isRendererUrl)).toEqual([
      true,
    ]);
    expect(navigation.reload).toHaveBeenCalledOnce();
  },
);

it.each(locations)('retries the current page at %s', async (href) => {
  const navigation = observeNavigation(href);
  renderFailure();

  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: tr('errorBoundary.retry') }),
    );
  });

  expect(navigation.destinations).toEqual([href]);
  expect(navigation.reload).toHaveBeenCalledOnce();
  expect(screen.getByRole('dialog')).toBeVisible();
});

it('keeps the frameless window controls available after a rendering error', async () => {
  render(
    <Localization>
      <ErrorFallback
        error={new Error('The library could not render')}
        resetErrorBoundary={vi.fn()}
      />
    </Localization>,
  );

  expect(screen.getByRole('dialog')).toBeVisible();
  expect(
    screen.getByRole('button', { name: tr('errorBoundary.retry') }),
  ).toBeVisible();
  expect(
    screen.getByRole('toolbar', { name: tr('windowControls') }),
  ).toBeVisible();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: tr('minimize') }));
    fireEvent.click(screen.getByRole('button', { name: tr('closeWindow') }));
  });
  expect(desktop.minimize).toHaveBeenCalledOnce();
  expect(desktop.close).toHaveBeenCalledOnce();
});
