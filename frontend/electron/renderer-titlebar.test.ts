import { tr } from '@neo-ui-kit/react';
import { readFileSync } from 'node:fs';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createElement, Fragment, useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  subscribeCloseRequests,
  useCloseGuard,
} from '../src/providers/close-guards';
import { ask, DialogView } from '../src/providers/dialog';
import { TitleBar } from '../src/app/TitleBar';

// Host-side integration test: read the actual stylesheet without adding Node access to renderer code.
const appStyles = readFileSync('src/app/app.css', 'utf8');

const desktop = vi.hoisted(() => ({
  close: vi.fn(async (): Promise<void> => undefined),
  confirmClose: vi.fn(async (_allowed: boolean) => undefined),
  onCloseRequested: vi.fn((_callback: () => void) => () => undefined),
  isFullscreen: vi.fn(async () => false),
  isMaximized: vi.fn(async () => false),
  onWindowState: vi.fn(() => () => undefined),
}));
vi.mock('../src/services/desktopClient', () => ({ desktopClient: desktop }));

const CloseFixture = () => {
  useCloseGuard(async () => {
    const choice = await ask({
      title: 'Confirm close',
      body: 'Work is still active.',
      actions: [
        { id: 'keep', label: 'Keep open' },
        { id: 'exit', label: 'Exit' },
      ],
    });
    return choice === 'exit';
  });
  useEffect(subscribeCloseRequests, []);
  return createElement(
    Fragment,
    null,
    createElement(TitleBar),
    createElement(DialogView),
  );
};

let styles: HTMLStyleElement;
const restoreNativeMethods: (() => void)[] = [];
const nativeMethod = (prototype: object, name: string, value: unknown) => {
  const original = Object.getOwnPropertyDescriptor(prototype, name);
  Object.defineProperty(prototype, name, { configurable: true, value });
  restoreNativeMethods.push(() => {
    if (original) Object.defineProperty(prototype, name, original);
    else Reflect.deleteProperty(prototype, name);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  let closeRequested: () => void = () => undefined;
  desktop.onCloseRequested.mockImplementation((callback) => {
    closeRequested = callback;
    return () => {
      closeRequested = () => undefined;
    };
  });
  desktop.close.mockImplementation(async () => closeRequested());

  // jsdom has no top layer. Preserve the native attributes and opening lifecycle
  // so the real TitleBar observer and portal participate in these DOM tests.
  nativeMethod(
    HTMLDialogElement.prototype,
    'showModal',
    function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  );
  nativeMethod(
    HTMLDialogElement.prototype,
    'close',
    function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  );
  const popovers = new WeakSet<Element>();
  nativeMethod(
    HTMLElement.prototype,
    'showPopover',
    function (this: HTMLElement) {
      popovers.add(this);
    },
  );
  nativeMethod(
    HTMLElement.prototype,
    'hidePopover',
    function (this: HTMLElement) {
      popovers.delete(this);
    },
  );
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    if (selector === ':modal') return matches.call(this, 'dialog[open]');
    if (selector === ':popover-open') return popovers.has(this);
    return matches.call(this, selector);
  });
  const querySelectorAll = document.querySelectorAll.bind(document);
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector) =>
    querySelectorAll(selector === 'dialog:modal' ? 'dialog[open]' : selector),
  );

  // Explicitly supply the native UA default that jsdom does not implement:
  // https://html.spec.whatwg.org/multipage/rendering.html#flow-content-3
  // This checks the CSS contract, not native scrollbar pixels or hit testing.
  styles = document.createElement('style');
  styles.textContent = `[popover] { overflow: auto; }\n${appStyles}`;
  document.head.append(styles);
});

afterEach(async () => {
  cleanup();
  await act(async () => undefined);
  styles?.remove();
  vi.restoreAllMocks();
  for (const restore of restoreNativeMethods.splice(0)) restore();
});

const requestClose = async () => {
  render(createElement(CloseFixture));
  fireEvent.click(screen.getByRole('button', { name: tr('closeWindow') }));
  const dialog = await screen.findByRole('dialog', { name: 'Confirm close' });
  await waitFor(() =>
    expect(
      screen.getByRole('toolbar', { name: tr('windowControls') }).parentElement,
    ).toBe(dialog),
  );
  return dialog;
};

it('keeps modal window controls outside native popover scrolling', async () => {
  await requestClose();
  const controls = screen.getByRole('toolbar', { name: tr('windowControls') });

  expect(controls).toHaveAttribute('popover', 'manual');
  expect(controls.matches(':popover-open')).toBe(true);
  expect(getComputedStyle(controls).display).toBe('flex');
  expect(getComputedStyle(controls).overflow).toBe('visible');
});

it.each([
  ['Keep open', false],
  ['Exit', true],
] as const)(
  'dispatches the first close click once and respects %s',
  async (action, allowed) => {
    const dialog = await requestClose();

    expect(desktop.close).toHaveBeenCalledOnce();
    expect(desktop.confirmClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: action }));

    await waitFor(() =>
      expect(desktop.confirmClose).toHaveBeenCalledExactlyOnceWith(allowed),
    );
    expect(desktop.close).toHaveBeenCalledOnce();
    expect(dialog).not.toBeInTheDocument();
    const controls = screen.getByRole('toolbar', {
      name: tr('windowControls'),
    });
    expect(controls).not.toHaveAttribute('popover');
    expect(controls.closest('.titleBar')).not.toBeNull();
  },
);
