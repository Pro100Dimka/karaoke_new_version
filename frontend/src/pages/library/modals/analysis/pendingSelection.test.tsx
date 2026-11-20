import { tr } from '@neo-ui-kit/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RecordingAnalysisProgress } from '../../../../contracts/clients';
import type { RecordingDto } from '../../../../contracts/models';
import '../../../../providers/localization';
import { PerformanceAnalysisModal } from './index';

const api = vi.hoisted(() => ({ retryRecordingPreparation: vi.fn() }));
vi.mock('../../../../services/pythonClient', () => ({ pythonClient: api }));
vi.mock('../../../../providers/notifications', () => ({
  useNotify: () => vi.fn(),
}));

// Keep the real dialog, preparation player and guarded retry action. No audio
// player is needed while the requested analysis is loading or has failed.
const take: RecordingDto = {
  id: 'selected-take',
  songId: 'song',
  filePath: '/recordings/selected.flac',
  displayName: 'Selected performance',
  createdAt: '2026-11-20T10:00:00Z',
  durationSeconds: 30,
  sizeBytes: 10000,
  analyzed: true,
  fileStatus: 'Ready',
};
const master: RecordingDto = {
  ...take,
  id: 'selected-master',
  sourceRecordingId: take.id,
  filePath: '/recordings/selected-master.mp3',
  createdAt: '2026-11-20T10:01:00Z',
};
const unrelated: RecordingDto = {
  ...take,
  id: 'newer-unrelated-take',
  displayName: 'Another performance',
  createdAt: '2026-11-20T10:02:00Z',
  fileStatus: 'PreparationFailed',
  analyzed: false,
};
const pending = (recordingId: string): RecordingAnalysisProgress => ({
  recordingId,
  jobId: '',
  state: 'Queued',
  stage: 'Loading',
  progress: 0,
});

beforeEach(() => vi.resetAllMocks());

it.each(['pending', 'failure'] as const)(
  'does not offer preparation retry for another take while a master analysis is %s',
  async (state) => {
    render(
      <PerformanceAnalysisModal
        analysis={null}
        recordingId={master.id}
        pending={state === 'pending' ? pending(master.id) : undefined}
        failure={state === 'failure' ? 'actionFailed' : undefined}
        recordings={[unrelated, master, take]}
        studioMaster={null}
        onDelete={vi.fn()}
        onCreateStudioMaster={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(
      screen.getByText(
        tr(state === 'pending' ? 'analysisLoading' : 'actionFailed'),
      ),
    ).toBeVisible();

    const retry = screen.queryByRole('button', {
      name: tr('Повторить подготовку'),
    });
    // Before the fix this visible action retried the newer, unrelated take.
    // Exercise it if offered, so RED proves the wrong API target as well as UI.
    if (retry) await act(async () => fireEvent.click(retry));
    expect(api.retryRecordingPreparation).not.toHaveBeenCalledWith(
      unrelated.id,
    );
    expect(retry).not.toBeInTheDocument();
  },
);

it.each(['pending', 'failure'] as const)(
  'keeps preparation retry addressed to the selected failed take during %s',
  async (state) => {
    const failed = { ...take, fileStatus: 'PreparationFailed' as const };
    render(
      <PerformanceAnalysisModal
        analysis={null}
        recordingId={failed.id}
        pending={state === 'pending' ? pending(failed.id) : undefined}
        failure={state === 'failure' ? 'recordingPreparationFailed' : undefined}
        recordings={[unrelated, failed]}
        studioMaster={null}
        onDelete={vi.fn()}
        onCreateStudioMaster={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: tr('Повторить подготовку') }),
      );
    });
    expect(api.retryRecordingPreparation).toHaveBeenCalledExactlyOnceWith(
      failed.id,
    );
  },
);

it('keeps preparation feedback on the selected take without offering another take retry', () => {
  const preparing = { ...take, fileStatus: 'Preparing' as const };
  render(
    <PerformanceAnalysisModal
      analysis={null}
      recordingId={preparing.id}
      pending={{ ...pending(preparing.id), stage: 'PreparingRecording' }}
      recordings={[unrelated, preparing]}
      studioMaster={null}
      onDelete={vi.fn()}
      onCreateStudioMaster={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('status', { name: tr('recordingPreparing') }),
  ).toBeVisible();
  expect(
    screen.queryByRole('button', { name: tr('Повторить подготовку') }),
  ).not.toBeInTheDocument();
});
