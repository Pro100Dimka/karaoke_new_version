import { tr } from '@neo-ui-kit/react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ErrorFallback from './error-boundary';
import Localization from './localization';

vi.mock('../app/TitleBar', () => ({ TitleBar: () => null }));

const writeText = vi.fn<(value: string) => Promise<void>>();
const execCommand = vi.fn<(command: string) => boolean>();
const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard',
);
const commandDescriptor = Object.getOwnPropertyDescriptor(
  document,
  'execCommand',
);

beforeEach(() => {
  vi.resetAllMocks();
  writeText.mockResolvedValue(undefined);
  execCommand.mockReturnValue(false);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand,
  });
});

afterEach(() => {
  for (const [target, key, descriptor] of [
    [navigator, 'clipboard', clipboardDescriptor],
    [document, 'execCommand', commandDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

const renderFailure = () => {
  const error = new Error('The editor could not render');
  render(
    <Localization>
      <ErrorFallback error={error} resetErrorBoundary={vi.fn()} />
    </Localization>,
  );
  return {
    error,
    copy: screen.getByRole('button', { name: tr('errorBoundary.copy') }),
  };
};

it('explains a denied report copy and allows the same report to be copied on retry', async () => {
  writeText.mockRejectedValueOnce(new Error('Clipboard is busy'));
  const { error, copy } = renderFailure();

  fireEvent.click(copy);

  expect(await screen.findByText(tr('actionFailed'))).toBeVisible();
  expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy');
  expect(copy).toBeEnabled();
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(writeText.mock.calls[0]?.[0]).toContain(error.stack);
  expect(writeText.mock.calls[0]?.[0]).toContain(tr('errorBoundary.version'));

  fireEvent.click(copy);

  await waitFor(() =>
    expect(screen.queryByText(tr('actionFailed'))).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(copy).toBeEnabled());
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(writeText.mock.calls[1]).toEqual(writeText.mock.calls[0]);
  expect(execCommand).toHaveBeenCalledOnce();
});

it('keeps browser clipboard success and the error recovery controls available', async () => {
  const { error, copy } = renderFailure();

  await act(async () => fireEvent.click(copy));

  const stack = error.stack;
  if (!stack) throw new Error('The error fixture must include its stack');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(stack),
  );
  expect(execCommand).not.toHaveBeenCalled();
  expect(screen.queryByText(tr('actionFailed'))).not.toBeInTheDocument();
  expect(copy).toBeEnabled();
  expect(
    screen.getByRole('button', { name: tr('errorBoundary.retry') }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: tr('errorBoundary.home') }),
  ).toBeEnabled();
});

it('retains the actual UI-kit copy fallback when the primary clipboard API refuses', async () => {
  writeText.mockRejectedValueOnce(new Error('Clipboard permission denied'));
  let fallbackText = '';
  execCommand.mockImplementation(() => {
    fallbackText = document.querySelector('textarea')?.value ?? '';
    return true;
  });
  const { error, copy } = renderFailure();

  await act(async () => fireEvent.click(copy));

  expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy');
  expect(fallbackText).toContain(error.stack);
  expect(document.querySelector('textarea')).toBeNull();
  expect(screen.queryByText(tr('actionFailed'))).not.toBeInTheDocument();
  expect(copy).toBeEnabled();
});

it('waits for the current report copy before allowing another attempt', async () => {
  let finish!: () => void;
  writeText.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const { copy } = renderFailure();

  fireEvent.click(copy);
  expect(copy).toBeDisabled();
  fireEvent.click(copy);
  expect(writeText).toHaveBeenCalledOnce();
  await act(async () => finish());

  expect(copy).toBeEnabled();
  expect(execCommand).not.toHaveBeenCalled();
});
