import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RecordingDto } from '../../../../contracts/models';
import { PerformanceAnalysisModal } from './index';

vi.mock('@neo-ui-kit/react', () => {
  const Panel = ({
    children,
    title,
  }: {
    children?: ReactNode;
    title?: ReactNode;
  }) => (
    <section>
      {title}
      {children}
    </section>
  );
  return {
    Dialog: Panel,
    Card: Panel,
    Stack: Panel,
    Typography: Panel,
    Landscape: Panel,
    Button: ({ label }: { label: string }) => <button>{label}</button>,
    IconButton: () => null,
    Planet: () => null,
    NeonWaves: () => null,
    MessageBar: Panel,
    ProgressBar: () => null,
    Loader: ({ label }: { label: string }) => <div role="status">{label}</div>,
    tr: (key: string) => key,
    useLocale: () => 'ru',
  };
});
vi.mock('../recordings/RecordingPlayer', () => ({
  RecordingPlayer: () => <div data-testid="recording-player" />,
}));
afterEach(cleanup);

it('replaces both playback cards with preparation status until the original is ready', () => {
  const recording: RecordingDto = {
    id: 'take',
    songId: 'song',
    filePath: '',
    displayName: '',
    createdAt: '',
    durationSeconds: 30,
    sizeBytes: 0,
    analyzed: true,
    fileStatus: 'Preparing',
  };
  const props = {
    analysis: {
      recordingId: 'take',
      score: 75,
      pitch: 75,
      rhythm: 75,
      stability: 75,
      summary: '',
    },
    recordings: [recording],
    onDelete: vi.fn(),
    onCreateStudioMaster: vi.fn(),
    studioMaster: null,
    onClose: vi.fn(),
  };
  const view = render(<PerformanceAnalysisModal {...props} />);
  expect(screen.queryByTestId('recording-player')).toBeNull();
  expect(screen.getByRole('status')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(
    <PerformanceAnalysisModal
      {...props}
      analysis={null}
      pending={{
        recordingId: 'take',
        jobId: 'job',
        stage: 'Queued',
        state: 'Queued',
        progress: 0,
      }}
    />,
  );
  expect(screen.getByRole('status')).toBeTruthy();
  expect(screen.queryByTestId('recording-player')).toBeNull();
  view.rerender(
    <PerformanceAnalysisModal
      {...props}
      recordings={[{ ...recording, fileStatus: 'Ready' }]}
    />,
  );
  expect(screen.getByTestId('recording-player')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button')).toBeTruthy();
});
