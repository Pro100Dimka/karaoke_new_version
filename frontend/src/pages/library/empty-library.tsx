import {
  Button,
  EmptyState,
  Stack,
  StatusIndicator,
  tr,
  useRouter,
} from '@neo-ui-kit/react';
import { useIsMutating, useQuery } from '@tanstack/react-query';
import {
  processingSettingsQuery,
  requiredModelsQuery,
} from '../../components/api-service';
import { routes } from '../../shared/routes';

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
  const { navigate } = useRouter();
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
    [true, () => navigate(routes.help), 'info', 'library.viewGuide', undefined],
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
