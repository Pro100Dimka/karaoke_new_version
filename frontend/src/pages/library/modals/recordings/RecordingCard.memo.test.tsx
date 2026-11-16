import {
  render,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RecordingDto } from '../../../../contracts/models';
import { RecordingCard } from './RecordingCard';
import { audioClient } from '../../../../services/audioClient';
import { store } from '../../../../providers/store';
import { runInAction } from 'mobx';

const drawn = vi.hoisted(() => ({ cards: 0 }));
vi.mock('@neo-ui-kit/react', () => ({
  Card: ({ children }: { children: ReactNode }) => {
    drawn.cards += 1;
    return <div>{children}</div>;
  },
  IconButton: () => null,
  AnimatedBorder: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  Waveform: () => null,
  Loader: () => null,
  RotaryKnob: ({
    value,
    label,
    onValueChange,
  }: {
    value: number;
    label: string;
    onValueChange(value: number): void;
  }) => (
    <input
      aria-label={label}
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={value}
      onChange={(event) => onValueChange(Number(event.target.value))}
    />
  ),
  MessageBar: () => null,
  ProgressBar: () => null,
  SegmentedControl: () => null,
  TextField: () => null,
  Typography: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  tr: (key: string) => key,
  useLocale: () => 'ru',
  setLocale: vi.fn(),
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
  vi.restoreAllMocks();
  runInAction(() => {
    store.playback.previewVolume = 1;
  });
});

it('keeps every recording volume knob on the one shared preview gain', async () => {
  const gain = vi
    .spyOn(audioClient, 'setPreviewVolume')
    .mockResolvedValue(undefined);
  const { RecordingPlayer: Player } =
    await vi.importActual<typeof import('./RecordingPlayer')>(
      './RecordingPlayer',
    );
  const recording: RecordingDto = {
    id: 'first',
    songId: 'song',
    filePath: '',
    displayName: '',
    createdAt: '',
    durationSeconds: 10,
    sizeBytes: 0,
    analyzed: false,
  };
  render(
    <>
      <Player recording={recording} />
      <Player recording={{ ...recording, id: 'second' }} />
    </>,
  );
  const knobs = screen.getAllByRole('slider', { name: 'recordingVolume' });
  const firstKnob = knobs[0];
  if (!firstKnob) throw new Error('Recording volume knob missing');
  fireEvent.change(firstKnob, { target: { value: '0.5' } });
  await waitFor(() => {
    for (const knob of knobs) expect(knob).toHaveValue('0.5');
  });
  expect(gain).toHaveBeenLastCalledWith(expect.closeTo(10 ** (-30 / 20), 12));
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
  view.rerender(<RecordingCard {...props} progress={{ unrelated: update }} />);
  expect(drawn.cards).toBe(1);
  view.rerender(
    <RecordingCard
      {...props}
      progress={{ take: { ...update, recordingId: 'take' } }}
    />,
  );
  expect(drawn.cards).toBe(2);
});
