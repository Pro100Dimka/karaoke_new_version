import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { HostWindowContext } from './hostWindow';
import { useDetachedPanel } from './useDetachedPanel';

const dispose: (() => void)[] = [];

afterEach(() => {
  cleanup();
  for (const release of dispose.splice(0).reverse()) release();
  vi.restoreAllMocks();
});

const childWindow = (): Window => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  dispose.push(() => frame.remove());
  const child = frame.contentWindow;
  if (!child) throw new Error('Child window must be available');
  return child;
};

const mockPanelWindow = (): Window => {
  const panel = childWindow();
  vi.spyOn(window, 'open').mockReturnValue(panel);
  vi.spyOn(panel, 'close').mockImplementation(() => {
    panel.dispatchEvent(new Event('pagehide'));
  });
  return panel;
};

const captureKeys = (host: Window) => {
  const listener = vi.fn((event: KeyboardEvent) => event.preventDefault());
  host.addEventListener('keydown', listener);
  dispose.push(() => host.removeEventListener('keydown', listener));
  return listener;
};

const usePanel = () =>
  useDetachedPanel('pianoRoll', 'Notes', { width: 600, height: 200 });

it('keeps detached shortcuts on the main window by default, including event metadata and prevention', () => {
  const panel = mockPanelWindow();
  const received = captureKeys(window);
  const hook = renderHook(usePanel);
  act(() => hook.result.current.detach());
  const properties = {
    key: 'K',
    code: 'KeyK',
    repeat: true,
    shiftKey: true,
    ctrlKey: true,
    altKey: true,
    metaKey: true,
    cancelable: true,
  };
  const key = new KeyboardEvent('keydown', properties);

  panel.dispatchEvent(key);

  expect(received).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining(properties),
  );
  expect(key.defaultPrevented).toBe(true);
});

it('routes detached shortcuts to the TV host without sending them to the laptop', () => {
  const tv = childWindow();
  const panel = mockPanelWindow();
  const laptopKeys = captureKeys(window);
  const tvKeys = captureKeys(tv);
  const wrapper = ({ children }: PropsWithChildren) => (
    <HostWindowContext.Provider value={tv}>
      {children}
    </HostWindowContext.Provider>
  );
  const hook = renderHook(usePanel, { wrapper });
  act(() => hook.result.current.detach());
  const key = new KeyboardEvent('keydown', {
    key: 'k',
    code: 'KeyK',
    cancelable: true,
  });

  panel.dispatchEvent(key);

  expect(tvKeys).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: 'k', code: 'KeyK' }),
  );
  expect(laptopKeys).not.toHaveBeenCalled();
  expect(key.defaultPrevented).toBe(true);
});

it('follows a changed karaoke host while the same detached panel stays open', () => {
  const tv = childWindow();
  const panel = mockPanelWindow();
  const laptopKeys = captureKeys(window);
  const tvKeys = captureKeys(tv);
  let host: Window = window;
  const wrapper = ({ children }: PropsWithChildren) => (
    <HostWindowContext.Provider value={host}>
      {children}
    </HostWindowContext.Provider>
  );
  const hook = renderHook(usePanel, { wrapper });
  act(() => hook.result.current.detach());
  fireEvent.keyDown(panel, { key: 'k', code: 'KeyK' });
  expect(laptopKeys).toHaveBeenCalledTimes(1);
  expect(tvKeys).not.toHaveBeenCalled();

  host = tv;
  hook.rerender();
  fireEvent.keyDown(panel, { key: 'n', code: 'KeyN' });

  expect(tvKeys).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: 'n', code: 'KeyN' }),
  );
  expect(laptopKeys).toHaveBeenCalledTimes(1);

  host = window;
  hook.rerender();
  fireEvent.keyDown(panel, { key: 't', code: 'KeyT' });

  expect(laptopKeys).toHaveBeenCalledTimes(2);
  expect(tvKeys).toHaveBeenCalledTimes(1);
  expect(window.open).toHaveBeenCalledTimes(1);
  expect(panel.close).not.toHaveBeenCalled();
});

it.each([
  ['input', 'k'],
  ['textarea', 't'],
  ['select', 'n'],
  ['button', ' '],
  ['slider', 'ArrowLeft'],
  ['listbox', 'ArrowDown'],
  ['option', 'ArrowUp'],
  ['editable', 'k'],
])('keeps %s control input inside the detached panel', (control, key) => {
  const tv = childWindow();
  const panel = mockPanelWindow();
  const laptopKeys = captureKeys(window);
  const tvKeys = captureKeys(tv);
  const wrapper = ({ children }: PropsWithChildren) => (
    <HostWindowContext.Provider value={tv}>
      {children}
    </HostWindowContext.Provider>
  );
  const hook = renderHook(usePanel, { wrapper });
  act(() => hook.result.current.detach());
  const element = panel.document.createElement(
    ['input', 'textarea', 'select', 'button'].includes(control)
      ? control
      : 'div',
  );
  let target = element;
  if (control === 'editable') {
    element.setAttribute('contenteditable', 'true');
    target = panel.document.createElement('span');
    element.append(target);
  } else if (['slider', 'listbox', 'option'].includes(control)) {
    element.setAttribute('role', control);
  }
  panel.document.body.append(element);
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });

  target.dispatchEvent(event);

  expect(tvKeys).not.toHaveBeenCalled();
  expect(laptopKeys).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});
