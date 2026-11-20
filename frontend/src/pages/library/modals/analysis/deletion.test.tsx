import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { RecordingDto } from '../../../../contracts/models';
import { PerformanceAnalysisModal } from './index';

vi.mock('@neo-ui-kit/react', () => {
  const Panel = ({
    children,
    title,
    actions,
  }: {
    children?: ReactNode;
    title?: ReactNode;
    actions?: ReactNode;
  }) => (
    <section>
      {title}
      {actions}
      {children}
    </section>
  );
  const Action = ({
    label,
    onClick,
    disabled,
  }: {
    label: string;
    onClick?(): void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
  return {
    Dialog: Panel,
    Card: Panel,
    Stack: Panel,
    Typography: Panel,
    Landscape: Panel,
    Button: Action,
    IconButton: Action,
    Planet: () => null,
    NeonWaves: () => null,
    MessageBar: Panel,
    ProgressBar: () => null,
    Loader: () => null,
    tr: (key: string) => key,
    useLocale: () => 'ru',
  };
});
vi.mock('../../songs/useGuardedAction', () => ({
  useGuardedAction: () => (work: () => unknown) => work(),
}));
vi.mock('../recordings/RecordingPlayer', () => ({
  RecordingPlayer: ({ recording }: { recording: RecordingDto }) => (
    <div
      data-testid={`player:${recording.id}`}
      data-file={recording.filePath}
    />
  ),
}));

const take: RecordingDto = {
  id: 'take',
  songId: 'song',
  filePath: '/take.flac',
  displayName: 'My take',
  createdAt: '2026-11-20T10:00:00Z',
  durationSeconds: 30,
  sizeBytes: 10000,
  analyzed: true,
  fileStatus: 'Ready',
};
const score = {
  recordingId: take.id,
  score: 80,
  pitch: 80,
  rhythm: 80,
  stability: 80,
  summary: '',
};

it.each(['take', 'older-master'])(
  'keeps the master player and delete action consistent with analysis of %s',
  (recordingId) => {
    const newest = {
      ...take,
      id: 'newest-master',
      filePath: '/newest.mp3',
      sourceRecordingId: take.id,
    };
    const older = {
      ...newest,
      id: 'older-master',
      filePath: '/older.mp3',
    };
    const expected = recordingId === take.id ? newest : older;
    const onDelete = vi.fn();
    render(
      <PerformanceAnalysisModal
        analysis={{ ...score, recordingId }}
        recordings={[newest, older, take]}
        studioMaster={null}
        onDelete={onDelete}
        onCreateStudioMaster={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('player:take')).toBeVisible();
    const player = screen.getByTestId(`player:${expected.id}`);
    expect(player).toHaveAttribute('data-file', expected.filePath);
    expect(screen.getAllByTestId(/^player:/)).toHaveLength(2);
    const card = player.closest('section');
    if (!card) throw new Error('The master player card is missing');
    fireEvent.click(
      within(card).getByRole('button', { name: 'recordingDelete' }),
    );
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(expected);
  },
);

it('removes playback and mastering actions after the analyzed take is deleted', () => {
  function Archive() {
    const [recordings, setRecordings] = useState([take]);
    return (
      <PerformanceAnalysisModal
        analysis={score}
        recordings={recordings}
        studioMaster={null}
        onDelete={(item) =>
          setRecordings((rows) => rows.filter((row) => row.id !== item.id))
        }
        onCreateStudioMaster={vi.fn()}
        onClose={vi.fn()}
      />
    );
  }
  render(<Archive />);
  expect(screen.getByTestId('player:take')).toHaveAttribute(
    'data-file',
    take.filePath,
  );
  fireEvent.click(screen.getByRole('button', { name: 'recordingDelete' }));
  expect(screen.queryByTestId('player:take')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'studioMasterCreate' }),
  ).toBeNull();
});

it('plays a retained master without fabricating its deleted source or offering to master it again', () => {
  const master = {
    ...take,
    id: 'master',
    filePath: '/master.mp3',
    sourceRecordingId: take.id,
  };
  render(
    <PerformanceAnalysisModal
      analysis={{ ...score, recordingId: master.id }}
      recordings={[master]}
      studioMaster={null}
      onDelete={vi.fn()}
      onCreateStudioMaster={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByTestId('player:master')).toHaveAttribute(
    'data-file',
    master.filePath,
  );
  expect(screen.queryByTestId('player:take')).toBeNull();
  expect(screen.queryByText('studioMasterSourceTitle')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'studioMasterCreate' }),
  ).toBeNull();
  expect(
    screen.getAllByRole('button', { name: 'recordingDelete' }),
  ).toHaveLength(1);
});

it('keeps the retained master visible when its source is deleted while comparing the two', () => {
  const master = {
    ...take,
    id: 'master',
    filePath: '/master.mp3',
    sourceRecordingId: take.id,
  };
  const props = {
    analysis: { ...score, recordingId: master.id },
    studioMaster: null,
    onDelete: vi.fn(),
    onCreateStudioMaster: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(
    <PerformanceAnalysisModal {...props} recordings={[take, master]} />,
  );
  expect(screen.getByTestId('player:take')).toBeTruthy();
  view.rerender(<PerformanceAnalysisModal {...props} recordings={[master]} />);
  expect(screen.queryByTestId('player:take')).toBeNull();
  expect(screen.getByTestId('player:master')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'studioMasterCreate' }),
  ).toBeNull();
});
