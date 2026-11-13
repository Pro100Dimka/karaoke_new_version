import { render, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RecordingDto } from '../../../../contracts/models';
import { RecordingCard } from './RecordingCard';

const drawn = vi.hoisted(() => ({ cards: 0 }));
vi.mock('@neo-ui-kit/react', () => ({
  Card: ({ children }: { children: ReactNode }) => {
    drawn.cards += 1;
    return <div>{children}</div>;
  },
  IconButton: () => null,
  MessageBar: () => null,
  ProgressBar: () => null,
  SegmentedControl: () => null,
  TextField: () => null,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  tr: (key: string) => key,
  useLocale: () => 'ru',
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, isError: false }),
}));
vi.mock('../../../../shared/hooks/useNearView', () => ({
  useNearView: () => false,
}));
vi.mock('./RecordingPlayer', () => ({ RecordingPlayer: () => null }));
vi.mock('../../songs/songMetadataPresentation', () => ({
  recordingStatusLabels: () => [],
}));

afterEach(() => {
  cleanup();
  drawn.cards = 0;
});

it('does not redraw unrelated takes on progress updates, but updates their selected versions', () => {
  const take: RecordingDto = {
    id: 'take',
    songId: 'song',
    filePath: '',
    displayName: '',
    createdAt: '',
    durationSeconds: 10,
    sizeBytes: 0,
    analyzed: false,
  };
  const callbacks = {
    onRename: vi.fn(),
    onAnalyze: vi.fn(),
    onDelete: vi.fn(),
    onCancelAnalysis: vi.fn(),
  };
  const props = {
    recording: take,
    name: 'Take',
    index: 0,
    progress: {},
    failures: {},
    ...callbacks,
  };
  const view = render(<RecordingCard {...props} />);
  expect(drawn.cards).toBe(1);
  const update = {
    recordingId: 'unrelated',
    jobId: 'job',
    state: 'Running' as const,
    stage: 'Loading' as const,
    progress: 20,
  };
  view.rerender(
    <RecordingCard {...props} progress={{ unrelated: update }} />,
  );
  expect(drawn.cards).toBe(1);
  view.rerender(
    <RecordingCard
      {...props}
      progress={{ take: { ...update, recordingId: 'take' } }}
    />,
  );
  expect(drawn.cards).toBe(2);
});
