import { tr } from '@neo-ui-kit/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
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
