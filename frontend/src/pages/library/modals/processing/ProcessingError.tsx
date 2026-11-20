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

export const processingErrorText = (
  job?: ProcessingJobDto,
  fallback = 'processingFailedHelp',
): string => {
  const error = job?.error;
  const explanation = error && errorstring(error);
  return [
    tr(
      explanation ??
        (job?.state === 'interrupted' ? 'processingInterruptedHelp' : fallback),
    ),
    error?.message,
    error?.code && `${tr('processingErrorCode')}: ${error.code}`,
    job?.stage && `${tr('processingDetailsStage')}: ${job.stage}`,
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
  const manualConflict = job?.error?.code === 'ManualLyricsConflict';
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
        {job?.error?.details && (
          <CollapsibleSection title={tr('processingErrorDetails')}>
            <Typography
              as="pre"
              variant="caption"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {job.error.details}
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
