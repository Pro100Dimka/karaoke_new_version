import {
  Button,
  CollapsibleSection,
  Dialog,
  MessageBar,
  Stack,
  Typography,
  tr,
  useLocale,
} from '@neo-ui-kit/react';
import type { ProcessingJobDto } from '../../../../contracts/models';
import { errorstring } from '../../../../shared/errors';
import { phaseOf, phases } from './processingModel';

export const processingErrorText = (
  job?: ProcessingJobDto,
  fallback = 'processingFailedHelp',
): string => {
  const error = job?.error;
  const explanation = error && errorstring(error);
  const phase = job ? phases[phaseOf(job) ?? -1] : undefined;
  return [
    tr(
      explanation ??
        (job?.state === 'interrupted' ? 'processingInterruptedHelp' : fallback),
    ),
    !explanation && error?.message,
    error?.code && `${tr('processingErrorCode')}: ${error.code}`,
    job?.stage && `${tr('processingDetailsStage')}: ${phase ? tr(phase) : job.stage}`,
  ]
    .filter(Boolean)
    .join('\n');
};

/** The same failure explanation and report actions in the queue and the song card. */
export const ProcessingErrorDialog = ({
  open,
  title,
  job,
  fallback,
  onClose,
  onRetry,
  onResetLyrics,
  onReport,
  retrying,
  reporting,
}: {
  open: boolean;
  title?: string;
  job?: ProcessingJobDto;
  fallback?: string;
  onClose(): void;
  onRetry?(): void;
  onResetLyrics?(): void;
  onReport(): void;
  retrying: boolean;
  reporting: boolean;
}) => {
  useLocale();
  const error = job?.error;
  const manualConflict = error?.code === 'ManualLyricsConflict';
  const details = [error && errorstring(error) && error.message, error?.details]
    .filter(Boolean)
    .join('\n');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      icon="warning"
      title={title ?? tr('failed')}
      cancelLabel={false}
      confirmLabel={false}
    >
      <Stack gap={3}>
        <MessageBar
          tone="error"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {processingErrorText(job, fallback)}
        </MessageBar>
        {details && (
          <CollapsibleSection title={tr('processingErrorDetails')}>
            <Typography
              as="pre"
              variant="caption"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {details}
            </Typography>
          </CollapsibleSection>
        )}
        <Typography variant="caption" tone="muted">
          {tr('processingReportHint')}
        </Typography>
        <Stack direction="row" gap={2} justify="end" wrap>
          <Button variant="ghost" onClick={onClose}>
            {tr('close')}
          </Button>
          <Button icon="upload" disabled={reporting} onClick={onReport}>
            {tr(reporting ? 'processingReportSending' : 'processingSendReport')}
          </Button>
          {manualConflict && onResetLyrics ? (
            <Button
              icon="refresh"
              variant="primary"
              disabled={retrying}
              onClick={onResetLyrics}
            >
              {tr('resetLyricsAndReprocess')}
            </Button>
          ) : (
            onRetry && (
              <Button
                icon="refresh"
                variant="primary"
                disabled={retrying}
                onClick={onRetry}
              >
                {tr('processingRetry')}
              </Button>
            )
          )}
        </Stack>
      </Stack>
    </Dialog>
  );
};
