import { fireEvent, render, screen } from '@testing-library/react';
import { tr } from '@neo-ui-kit/react';
import { expect, it, vi } from 'vitest';
import { Transport } from './Transport';

it('stops manually without passing a mouse event as the playlist continuation flag', () => {
  const stop = vi.fn();
  render(
    <Transport
      state={{ kind: 'playing' }}
      position={12}
      duration={200}
      seekLocked={false}
      onSeek={vi.fn()}
      onTogglePlay={vi.fn()}
      onStop={stop}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: tr('stop') }));

  expect(stop).toHaveBeenCalledExactlyOnceWith();
});
