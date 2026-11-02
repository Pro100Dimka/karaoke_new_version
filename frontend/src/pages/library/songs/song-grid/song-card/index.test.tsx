import { fireEvent, render } from '@testing-library/react';
import { Card } from '@neo-ui-kit/react';
import { describe, expect, it, vi } from 'vitest';
import type { SongDto } from '../../../../../contracts/models';
import { QueryProvider } from '../../../../../test/QueryProvider';
import { SongCard } from './index';

vi.mock('@neo-ui-kit/react', async (original) => {
  const kit = await original<typeof import('@neo-ui-kit/react')>();
  return { ...kit, Card: vi.fn(kit.Card) };
});

const song: SongDto = {
  id: 'song',
  title: 'Song',
  artist: 'Artist',
  language: 'Auto',
  status: 'ready',
  durationSeconds: 180,
  createdAt: '',
  coverState: 'Fallback',
  activeRevision: 1,
  projectFormatVersion: 1,
};
const actions = {
  onPlay: vi.fn(),
  onOpenProcessing: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenRecordings: vi.fn(),
};

describe('SongCard selection updates', () => {
  it('keeps unchanged cards rendered while the virtual grid updates', () => {
    const selection = {
      checked: false,
      active: false,
      disabled: false,
      toggle: vi.fn(),
    };
    const card = () => (
      <QueryProvider>
        <SongCard song={song} {...actions} selection={{ ...selection }} />
      </QueryProvider>
    );
    const view = render(card());
    const renders = vi.mocked(Card).mock.calls.length;
    view.rerender(card());
    expect(vi.mocked(Card).mock.calls.length).toBe(renders);
  });

  it('updates selection, disabled state and the current handler', () => {
    const toggle = vi.fn();
    const card = (checked: boolean, disabled: boolean, handler = toggle) => (
      <QueryProvider>
        <SongCard
          song={song}
          {...actions}
          selection={{ checked, active: checked, disabled, toggle: handler }}
        />
      </QueryProvider>
    );
    const view = render(card(false, false));
    fireEvent.click(view.getByRole('checkbox'));
    expect(toggle).toHaveBeenCalledWith(song.id);
    view.rerender(card(true, true));
    expect(view.getByRole('checkbox')).toBeChecked();
    expect(view.getByRole('checkbox')).toBeDisabled();
    const replacement = vi.fn();
    view.rerender(card(true, false, replacement));
    fireEvent.click(view.getByRole('checkbox'));
    expect(replacement).toHaveBeenCalledWith(song.id);
  });
});
