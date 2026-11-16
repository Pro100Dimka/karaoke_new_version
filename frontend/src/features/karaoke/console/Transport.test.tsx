import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { tr } from '@neo-ui-kit/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Transport } from './Transport';
import { ConsoleFrame } from './ConsoleFrame';
import { useDetachedPanel } from '../../../shared/ui/useDetachedPanel';

afterEach(() => vi.restoreAllMocks());

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

it('forwards repeat and modifier keys from a detached panel without consuming control input', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const panel = frame.contentWindow;
  if (!panel) throw new Error('Detached document must exist');
  vi.spyOn(window, 'open').mockReturnValue(panel);
  vi.spyOn(panel, 'close').mockImplementation(() => { panel.dispatchEvent(new Event('pagehide')); });
  const received: KeyboardEvent[] = [];
  const capture = (event: KeyboardEvent) => { received.push(event); event.preventDefault(); };
  window.addEventListener('keydown', capture);
  const hook = renderHook(() => useDetachedPanel('keyboard-test', 'Panel', { width: 600, height: 200 }));
  try {
    act(() => hook.result.current.detach());
    const held = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', repeat: true, shiftKey: true, cancelable: true });
    panel.dispatchEvent(held);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ key: 'k', code: 'KeyK', repeat: true, shiftKey: true });
    expect(held.defaultPrevented).toBe(true);
    const input = panel.document.createElement('input');
    panel.document.body.append(input);
    fireEvent.keyDown(input, { key: 'k', repeat: true });
    expect(received).toHaveLength(1);
  } finally {
    window.removeEventListener('keydown', capture);
    hook.unmount();
    frame.remove();
  }
});

it('keeps collapsed console controls inert and restores them when expanded', () => {
  const props = {
    panel: {
      container: null, detached: false, detach: vi.fn(), attach: vi.fn(),
      heldPointer: { current: null }, resumeDrag: vi.fn(),
    },
    placement: { layout: null, save: vi.fn() },
    width: 800, controlsVisible: true, label: 'Console', vertical: false, onFloat: vi.fn(),
  };
  const view = render(<ConsoleFrame {...props} shown={false}><button>Control</button></ConsoleFrame>);
  const panel = view.container.querySelector('aside');
  expect(panel).toHaveAttribute('inert');
  expect(panel).toHaveAttribute('aria-hidden', 'true');
  const control = view.container.querySelector('button');
  view.rerender(<ConsoleFrame {...props} shown><button>Control</button></ConsoleFrame>);
  expect(panel).not.toHaveAttribute('inert');
  expect(screen.getByRole('button', { name: 'Control' })).toBe(control);
});
