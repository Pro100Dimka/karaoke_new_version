import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotificationsProvider, useNotify } from '../providers/notifications';
import { TitleBar } from './TitleBar';

vi.mock('@neo-ui-kit/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neo-ui-kit/react')>()),
  useLocale: () => undefined,
  tr: (key: string) => key,
  IconButton: ({ label }: { label: string }) => <button>{label}</button>,
  Toast: ({ message }: { message: string }) => (
    <div role="status">{message}</div>
  ),
}));
vi.mock('./useWindowState', () => ({
  useWindowState: () => ({ fullscreen: false, maximized: false }),
}));

let notify: ReturnType<typeof useNotify>;
const Notice = () => {
  notify = useNotify();
  return null;
};

const restore: (() => void)[] = [];
const method = (prototype: object, name: string, value: unknown) => {
  const previous = Object.getOwnPropertyDescriptor(prototype, name);
  Object.defineProperty(prototype, name, { configurable: true, value });
  restore.push(() => {
    if (previous) Object.defineProperty(prototype, name, previous);
    else Reflect.deleteProperty(prototype, name);
  });
};

const flushMutations = () =>
  act(async () => {
    await Promise.resolve();
  });
const openDialog = (parent = document.body) => {
  const dialog = document.createElement('dialog');
  parent.append(dialog);
  dialog.showModal();
  return dialog;
};

beforeEach(() => {
  // jsdom has no top layer; keep the browser's open/close and selector contracts observable.
  method(
    HTMLDialogElement.prototype,
    'showModal',
    function (this: HTMLDialogElement) {
      this.dataset.testModal = '';
      this.open = true;
    },
  );
  method(
    HTMLDialogElement.prototype,
    'close',
    function (this: HTMLDialogElement) {
      this.open = false;
    },
  );
  method(HTMLElement.prototype, 'showPopover', () => undefined);
  method(HTMLElement.prototype, 'hidePopover', () => undefined);
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return matches.call(
      this,
      selector === ':modal'
        ? 'dialog[data-test-modal][open]'
        : selector === ':popover-open'
          ? '[data-test-popover]'
          : selector,
    );
  });
  const query = document.querySelectorAll.bind(document);
  vi.spyOn(document, 'querySelectorAll').mockImplementation(
    <E extends Element = Element>(selector: string) =>
      query<E>(
        selector === 'dialog:modal'
          ? 'dialog[data-test-modal][open]'
          : selector,
      ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const reset of restore.splice(0).reverse()) reset();
  document.body.replaceChildren();
});

it('does not rescan the document for modals when ordinary live content changes', async () => {
  const { container } = render(
    <NotificationsProvider>
      <div className="main-theme">
        <TitleBar />
        <Notice />
      </div>
    </NotificationsProvider>,
  );
  act(() => notify('Saved', 'success', { silent: true }));
  const rows = document.createElement('div');
  for (let index = 0; index < 2000; index++)
    rows.append(document.createElement('div'));
  container.append(rows);
  const clock = document.createElement('span');
  rows.append(clock);
  await flushMutations();
  const queries = vi.mocked(document.querySelectorAll);
  queries.mockClear();
  for (let tick = 0; tick < 60; tick++) {
    clock.replaceChildren(String(tick));
    await flushMutations();
  }
  expect(
    queries.mock.calls.filter(([selector]) => selector === 'dialog:modal'),
  ).toHaveLength(0);
  expect(screen.getByRole('status')).toHaveTextContent('Saved');
  expect(screen.getByRole('toolbar').closest('dialog')).toBeNull();
});

it('keeps title-bar controls in the last opened modal through closing, reopening and removal', async () => {
  render(<TitleBar />);
  const first = openDialog();
  const second = openDialog();
  await flushMutations();
  expect(screen.getByRole('toolbar').closest('dialog')).toBe(second);
  first.close();
  await flushMutations();
  first.showModal();
  await flushMutations();
  expect(screen.getByRole('toolbar').closest('dialog')).toBe(first);
  first.close();
  await flushMutations();
  expect(screen.getByRole('toolbar').closest('dialog')).toBe(second);
  const wrapper = document.createElement('section');
  document.body.append(wrapper);
  wrapper.append(second);
  await flushMutations();
  wrapper.remove();
  await flushMutations();
  expect(screen.getByRole('toolbar').closest('dialog')).toBeNull();
});

it('moves notices into added modal subtrees and back when their parent is removed', async () => {
  render(
    <NotificationsProvider>
      <div className="main-theme">
        <Notice />
      </div>
    </NotificationsProvider>,
  );
  act(() => notify('Saved', 'success', { silent: true }));
  await flushMutations();
  const theme = document.querySelector('.main-theme');
  expect(theme).toContainElement(screen.getByRole('status'));
  const wrapper = document.createElement('section');
  const dialog = openDialog(wrapper);
  document.body.append(wrapper);
  await flushMutations();
  expect(dialog).toContainElement(screen.getByRole('status'));
  wrapper.remove();
  await flushMutations();
  expect(theme).toContainElement(screen.getByRole('status'));
});
