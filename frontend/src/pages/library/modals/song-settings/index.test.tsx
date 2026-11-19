import { tr } from '@neo-ui-kit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../contracts/models';
import { pythonClient } from '../../../../services/pythonClient';
import { SongSettingsModal } from './index';

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../../services/pythonClient', () => ({
  pythonClient: { updateSong: vi.fn() },
}));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));
vi.mock('../../songs/useSongActions', () => ({
  useSongActions: () => ({ confirmDelete: vi.fn() }),
}));
vi.mock('../../../../components/api-service', () => ({
  refreshSongs: vi.fn(async () => undefined),
}));

const song: SongDto = {
  id: 'song',
  title: 'Song title',
  artist: 'Incorrect artist',
  language: 'Auto',
  status: 'not-processed',
  durationSeconds: 180,
  createdAt: '2026-11-19T00:00:00Z',
  coverState: 'Fallback',
  activeRevision: 0,
  projectFormatVersion: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pythonClient.updateSong).mockResolvedValue(song);
});

it.each(['', '   '])(
  'saves an explicitly cleared artist (%j)',
  async (artist) => {
    const onClose = vi.fn();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SongSettingsModal song={song} onClose={onClose} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: tr('artist') }), {
      target: { value: artist },
    });
    fireEvent.click(screen.getByRole('button', { name: tr('save') }));
    await waitFor(() =>
      expect(pythonClient.updateSong).toHaveBeenCalledWith(
        song.id,
        expect.objectContaining({ title: song.title, artist: '' }),
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  },
);
