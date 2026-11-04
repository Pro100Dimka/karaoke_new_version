import {
  Button,
  EmptyState,
  Stack,
  StatusIndicator,
  tr,
} from '@neo-ui-kit/react';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import {
  requiredModelsQuery,
  processingSettingsQuery,
} from '../../api/api-service';

type EmptyKind = 'firstRun' | 'noResults';
export const LibraryEmptyState = ({
  kind,
  onOpenAudioSettings,
  onOpenModels,
}: {
  kind: EmptyKind;
  onOpenAudioSettings(): void;
  onOpenModels(): void;
}) => {
  const savingBackend =
    useIsMutating({ mutationKey: ['processing-settings'] }) > 0;
  const processing = useQuery({
    ...processingSettingsQuery,
    enabled: kind === 'firstRun' && !savingBackend,
  });
  const local = processing.data?.processingBackend === 'Local';
  const models = useQuery({
    ...requiredModelsQuery,
    enabled: kind === 'firstRun' && local,
  });
  if (kind === 'noResults')
    return <StatusIndicator status="info" label={tr('library.noMatches')} />;
  const buttons = [
    [true, onOpenAudioSettings, 'chip', 'library.configureAudio', 'primary'],
    [
      local && models.data?.some((model) => model.state !== 'Ready'),
      onOpenModels,
      'wave',
      'library.downloadRequiredModels',
      undefined,
    ],
  ] as const;
  return (
    <EmptyState
      icon="sparkle"
      title={tr('library.firstSongTitle')}
      description={tr('library.noSongsBody')}
      action={
        <Stack direction="row" gap={3} justify="center" wrap>
          {buttons
            .filter(([visible]) => visible)
            .map(([, onClick, icon, label, variant]) => (
              <Button
                key={label}
                size="lg"
                icon={icon}
                variant={variant}
                label={tr(label)}
                onClick={onClick}
              />
            ))}
        </Stack>
      }
    />
  );
};
