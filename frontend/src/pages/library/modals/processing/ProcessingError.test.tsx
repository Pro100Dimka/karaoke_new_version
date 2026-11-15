import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { setLocale } from '@neo-ui-kit/react';
import { afterEach, expect, it, vi } from 'vitest';
import '../../../../providers/localization';
import type { ProcessingJobDto } from '../../../../contracts/models';
import { ProcessingErrorDialog, processingErrorText } from './ProcessingError';

afterEach(cleanup);

const job: ProcessingJobDto = {
  id: 'job',
  type: 'song',
  songId: 'song',
  state: 'failed',
  stage: 'separation',
  progress: 0.4,
  error: {
    code: 'ProcessingTimeout',
    message: 'Worker timed out',
    source: 'python',
  },
};

it('keeps the failure message, stable code and stage in the shared explanation', () => {
  setLocale('ru');
  const text = processingErrorText(job);
  expect(text).toContain('Worker timed out');
  expect(text).toContain('ProcessingTimeout');
  expect(text).toContain('separation');
  expect(text).not.toContain('processingFailedHelp');
  expect(
    processingErrorText({ ...job, state: 'interrupted', error: undefined }),
  ).not.toContain('processingInterruptedHelp');
});

it('offers retry and report actions and blocks duplicate clicks while busy', () => {
  setLocale('ru');
  const retry = vi.fn(),
    report = vi.fn();
  const props = {
    open: true,
    job,
    onClose: vi.fn(),
    onRetry: retry,
    onReport: report,
  };
  const view = render(
    <ProcessingErrorDialog {...props} retrying={false} reporting={false} />,
  );
  expect(screen.getByText(/Worker timed out/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Повторить обработку' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Отправить отчёт об ошибке' }),
  );
  expect(retry).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  view.rerender(<ProcessingErrorDialog {...props} retrying reporting />);
  const retryButton = screen.getByRole('button', {
    name: 'Повторить обработку',
  });
  const reportButton = screen.getByRole('button', {
    name: 'Отправляем отчёт…',
  });
  expect(retryButton.hasAttribute('disabled')).toBe(true);
  expect(reportButton.hasAttribute('disabled')).toBe(true);
  fireEvent.click(retryButton);
  fireEvent.click(reportButton);
  expect(retry).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
});
