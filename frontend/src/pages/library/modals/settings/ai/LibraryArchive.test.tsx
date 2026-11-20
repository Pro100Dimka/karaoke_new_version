import { fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setLocale } from '@neo-ui-kit/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '../../../../../providers/localization';
import { pythonClient } from '../../../../../services/pythonClient';
import { LibraryArchive } from './rows';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../../providers/notifications', () => ({
  useNotify: () => notify,
  useErrorHandler: () => vi.fn(),
}));
vi.mock('../../../../../services/pythonClient', () => ({
  pythonClient: { importLibrary: vi.fn() },
}));
vi.mock('../../../../../services/desktopClient', () => ({
  desktopClient: { pathForFile: () => '/backup.zip' },
}));

beforeEach(() => vi.clearAllMocks());

it.each([
  [
    'ru',
    'Песни: добавлено 0, уже в библиотеке 3. Записи: добавлено 2, уже в библиотеке 0.',
  ],
  [
    'uk',
    'Пісні: додано 0, уже в бібліотеці 3. Записи: додано 2, уже в бібліотеці 0.',
  ],
  [
    'en',
    'Songs: added 0, already in the library 3. Recordings: added 2, already in the library 0.',
  ],
])(
  'shows all four reported counts in %s, including valid zero counts',
  async (locale, expected) => {
    setLocale(locale);
    vi.mocked(pythonClient.importLibrary).mockResolvedValue({
      imported: 0,
      skipped: 3,
      recordingsAdded: 2,
      recordingsSkipped: 0,
    });
    await importBackup();
    await waitFor(() =>
      expect(notify).toHaveBeenCalledExactlyOnceWith(expected, 'success'),
    );
  },
);

it.each([
  ['ru', 'Добавлено песен: 0. Уже в библиотеке: 3.'],
  ['uk', 'Додано пісень: 0. Уже в бібліотеці: 3.'],
  ['en', 'Songs added: 0. Already in the library: 3.'],
])(
  'keeps the legacy %s message when the backend did not report recording counts',
  async (locale, expected) => {
    setLocale(locale);
    vi.mocked(pythonClient.importLibrary).mockResolvedValue({
      imported: 0,
      skipped: 3,
    });
    await importBackup();
    await waitFor(() =>
      expect(notify).toHaveBeenCalledExactlyOnceWith(expected, 'success'),
    );
  },
);

const importBackup = async () => {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <LibraryArchive />
    </QueryClientProvider>,
  );
  const input =
    view.container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Library archive file picker was not rendered');
  fireEvent.change(input, {
    target: {
      files: [new File(['archive'], 'backup.zip', { type: 'application/zip' })],
    },
  });
  await waitFor(() =>
    expect(pythonClient.importLibrary).toHaveBeenCalledOnce(),
  );
};
