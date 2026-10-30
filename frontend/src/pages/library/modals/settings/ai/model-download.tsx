import { pythonClient } from '../../../../../services/pythonClient';
import { useNotify } from '../../../../../providers/notifications';
import {
  Button,
  ProgressBar,
  Stack,
  StatusIndicator,
  tr,
  Typography,
} from '@neo-ui-kit/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  isActiveJob,
  isModelBusy,
  jobQuery,
  modelKey,
} from '../../../../../api/api-service';
import type { ModelCardProps } from '../../../../../utils/contracts';

const formats = new Map<string, Intl.NumberFormat>();
const byteUnits = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
const modelStatuses = {
  Missing: ['warning', 'modelNotInstalled'],
  Downloading: ['processing', 'modelDownloading'],
  Verifying: ['processing', 'modelVerifying'],
  Ready: ['success', 'modelReady'],
  Failed: ['error', 'modelFailed'],
  ModelUpdateAvailable: ['warning', 'modelUpdateAvailable'],
} as const;

const ModelDownload = (props: ModelCardProps) => {
  const { model, locale, progressError, disabled, pending, onAction } = props;
  const format = (value: number, unit: string) => {
    const key = `${locale}:${unit}`;
    let formatter = formats.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, {
        maximumFractionDigits: 1,
        style: unit === 'percent' ? 'percent' : 'unit',
        unit: unit === 'percent' ? undefined : unit,
      });
      formats.set(key, formatter);
    }
    return formatter.format(value);
  };
  const formatBytes = (value: number) => {
    let unit = 0;

    while (value >= 1024 && unit < byteUnits.length - 1) {
      value /= 1024;
      unit++;
    }

    return format(value, byteUnits[unit] ?? 'byte');
  };

  const {
    data: job,
    error,
    refetch,
  } = useQuery({
    ...jobQuery('ModelDownload', modelKey(model)),
    enabled: isModelBusy(model),
  });
  const notify = useNotify();
  const cancel = useMutation({ mutationFn: (id: string) => pythonClient.cancelJob(id),
    onSuccess: () => refetch(), onError: (error) => notify(error.message, 'error') });
  const unavailable = progressError || !!error;
  const activeJob = isModelBusy(model) && job && isActiveJob(job) ? job : undefined;
  const installed = model.state === 'Ready';
  const busy = !!activeJob || isModelBusy(model);
  const verifying =
    model.state === 'Verifying' || activeJob?.stage === 'Verify';
  const progress =
    !unavailable && !verifying && activeJob?.stage === 'Download'
      ? activeJob.stageProgress
      : undefined;
  const received = Math.round(model.size * (progress ?? 0));
  const phase = (
    [
      [verifying, 'Verifying', 'modelDownloadVerifying'],
      [
        busy,
        'Downloading',
        unavailable ? 'modelProgressUnavailable' : 'modelProgressWaiting',
      ],
    ] as const
  ).find(([active]) => active);
  const [status, label] = modelStatuses[phase?.[1] ?? model.state];
  const actionLabel = tr(installed ? 'modelDelete' : 'modelDownload');

  return (
    <Stack gap={3} style={{ flex: 1 }}>
      <StatusIndicator status={status} label={tr(label)} />

      {!installed && !busy && (
        <Stack gap={1}>
          {Object.entries({
            modelDownloadSize: model.size,
            modelRequiredSpace: model.requiredDiskBytes,
          }).map(([label, bytes]) => (
            <Typography key={label} variant="caption" tone="muted">
              {tr(label, { size: formatBytes(bytes) })}
            </Typography>
          ))}
        </Stack>
      )}

      {busy ? (
        <Stack gap={2} style={{ marginTop: 'auto' }}>
          {progress !== undefined && (
            <>
              <Stack direction="row" justify="between" gap={2} wrap>
                <Typography variant="caption" tone="muted">
                  {tr('modelDownloadedOf', {
                    downloaded: formatBytes(received),
                    total: formatBytes(model.size),
                  })}
                </Typography>
                <Typography variant="caption">
                  {format(Math.floor(progress * 1000) / 1000, 'percent')}
                </Typography>
              </Stack>
              <ProgressBar
                value={progress * 100}
                label={`${tr(label)} ${model.modelId}`}
              />
            </>
          )}
          <Typography variant="caption" tone="muted">
            {progress !== undefined
              ? tr('modelDownloadRemaining', {
                  size: formatBytes(model.size - received),
                })
              : tr(phase?.[2] ?? 'modelProgressWaiting')}
          </Typography>
          {activeJob && <Button size="sm" variant="ghost" icon="close" label={tr('cancel')}
            disabled={cancel.isPending || activeJob.state === 'Cancelling'}
            onClick={() => cancel.mutate(activeJob.jobId)} />}
          {error && (
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              label={tr('retry')}
              onClick={() => void refetch()}
            />
          )}
        </Stack>
      ) : (
        <Button
          icon={installed ? 'trash' : 'download'}
          variant={installed ? 'ghost' : 'primary'}
          aria-label={`${actionLabel} ${model.modelId}`}
          disabled={disabled}
          loading={pending}
          onClick={() => onAction(model)}
          style={{ marginTop: 'auto', width: '100%' }}
          label={actionLabel}
        />
      )}
    </Stack>
  );
};

export default ModelDownload;
