import { tr } from '@neo-ui-kit/react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServiceBanner } from './ServiceBanner';
import {
  updateAvailable,
  updateDownload,
  updateReady,
} from './desktop/shellBus';

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ pathname: '/' }),
}));
vi.mock('../providers/store', () => ({
  store: {
    application: {
      services: { python: { kind: 'ready' }, audio: { kind: 'ready' } },
    },
  },
}));
vi.mock('../providers/notifications', () => ({ useNotify: () => vi.fn() }));

beforeEach(() => {
  updateAvailable.set('1.2.0');
  updateReady.set(null);
  updateDownload.set(null);
});
afterEach(() => {
  cleanup();
  updateAvailable.set(null);
  updateReady.set(null);
  updateDownload.set(null);
});

const offerText = (version: string) =>
  tr('Доступно обновление A&D Voice {version}', { version });

it('offers a newer release after the previous release was dismissed', () => {
  render(<ServiceBanner />);
  expect(screen.getByText(offerText('1.2.0'))).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: tr('Отклонить') }));
  expect(screen.queryByText(offerText('1.2.0'))).not.toBeInTheDocument();

  // The updater discovers a later release during its next periodic check.
  act(() => updateAvailable.set('1.3.0'));

  expect(screen.getByText(offerText('1.3.0'))).toBeVisible();
  expect(screen.getByRole('button', { name: tr('Установить') })).toBeEnabled();
});

it('keeps the same release dismissed if the desktop republishes its offer', () => {
  render(<ServiceBanner />);
  fireEvent.click(screen.getByRole('button', { name: tr('Отклонить') }));

  act(() => updateAvailable.set(null));
  act(() => updateAvailable.set('1.2.0'));

  expect(screen.queryByText(offerText('1.2.0'))).not.toBeInTheDocument();
});

it('still shows a downloaded release after its initial offer was dismissed', () => {
  render(<ServiceBanner />);
  fireEvent.click(screen.getByRole('button', { name: tr('Отклонить') }));

  act(() => updateReady.set('1.2.0'));

  expect(
    screen.getByRole('button', { name: tr('Обновить сейчас') }),
  ).toBeEnabled();
});
