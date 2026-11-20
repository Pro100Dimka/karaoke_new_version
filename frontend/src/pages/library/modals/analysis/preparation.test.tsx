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
    ProgressBar: ({ label, value }: { label: string; value: number }) => (
      <div role="progressbar" aria-label={label} aria-valuenow={value} />
    ),
    Loader: ({ label }: { label: string }) => <div role="status">{label}</div>,
    tr: (key: string) => key,
    useLocale: () => 'ru',
    setLocale: vi.fn(),
  };
});
vi.mock('../recordings/RecordingPlayer', () => ({
  RecordingPlayer: () => <div data-testid="recording-player" />,
}));
afterEach(cleanup);

it.each([
  ['PreparingStudioSources', 'studioMasterPreparingSources'],
  ['AligningStudioVoice', 'studioMasterAligningVoice'],
  ['PreparingStudioVoice', 'studioMasterPreparingVoice'],
  ['ProcessingStudioVoice', 'studioMasterProcessingVoice'],
  ['MixingStudioMaster', 'studioMasterMixing'],
  ['MasteringRecording', 'studioMasterMastering'],
  ['PublishingStudioMaster', 'studioMasterPublishing'],
  ['PitchAnalysis', 'analysisPitchTracking'],
  ['ReferencePitchAnalysis', 'analysisReferenceTracking'],
  ['Queued', 'analysisWaitingResources'],
  ['SeparatingPerformance', 'analysisSeparating'],
  ['FutureStudioStage', 'studioMasterTitle'],
])('shows a localized Studio Master stage for %s', (stage, label) => {
  const recording: RecordingDto = {
    id: 'take',
    songId: 'song',
    filePath: '',
    displayName: '',
    createdAt: '',
    durationSeconds: 30,
    sizeBytes: 0,
    analyzed: true,
    fileStatus: 'Ready',
  };
  render(
    <PerformanceAnalysisModal
      analysis={{
        recordingId: recording.id,
        score: 75,
        pitch: 75,
        rhythm: 75,
        stability: 75,
        summary: '',
      }}
      recordings={[recording]}
      onDelete={vi.fn()}
      onCreateStudioMaster={vi.fn()}
      studioMaster={{ recordingId: recording.id, stage, progress: 73 }}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen
      .getByRole('progressbar', { name: label })
      .getAttribute('aria-valuenow'),
  ).toBe('73');
  expect(screen.getByText('studioMasterProgressValue')).toBeTruthy();
});

it.each([
  [84, false, undefined],
  [undefined, false, undefined],
  [84, true, undefined],
  [undefined, true, undefined],
  [undefined, false, 'pending'],
  [undefined, true, 'pending'],
] as const)(
  'shows room result %s and the personal analysis of master=%s',
  (overallScore, master, status) => {
    const recording: RecordingDto = {
      id: 'duet-take',
      songId: 'song',
      filePath: '',
      displayName: '',
      createdAt: '',
      durationSeconds: 30,
      sizeBytes: 0,
      analyzed: true,
      fileStatus: 'Ready',
      roomPerformance: {
        roomId: 'room',
        performanceId: 7,
        overallScore,
        status,
      },
    };
    render(
      <PerformanceAnalysisModal
        analysis={{
          recordingId: master ? 'duet-master' : 'duet-take',
          score: 75,
          pitch: 70,
          rhythm: 80,
          stability: 75,
          summary: '',
        }}
        recordings={[
          recording,
          { ...recording, id: 'duet-master', sourceRecordingId: recording.id },
        ]}
        onDelete={vi.fn()}
        onCreateStudioMaster={vi.fn()}
        studioMaster={null}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        overallScore === undefined
          ? status === 'pending'
            ? 'roomPerformancePending'
            : 'roomPerformanceUnavailable'
          : '84',
      ),
    ).toBeTruthy();
    expect(screen.getByText('roomPerformanceOverall')).toBeTruthy();
    expect(screen.getByText('roomPerformancePersonal')).toBeTruthy();
    expect(screen.getByText('75')).toBeTruthy();
  },
);

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
  expect(screen.getByText('performanceAnalysis')).toBeTruthy();
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
