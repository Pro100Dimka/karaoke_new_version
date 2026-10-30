import { Button, EmptyState, Stack, StatusIndicator, tr } from '@neo-ui-kit/react';

export type EmptyKind = 'firstRun' | 'noResults';
export const LibraryEmptyState = ({ kind, onOpenAudioSettings, onOpenModels }: {
  kind: EmptyKind;
  onOpenAudioSettings(): void;
  onOpenModels(): void;
}) => {
  if (kind === 'noResults') return <StatusIndicator status="info" label={tr('library.noMatches')} />;
  const buttons = [
    [onOpenAudioSettings, 'chip', 'library.configureAudio', 'primary'],
    [onOpenModels, 'wave', 'library.downloadRequiredModels', undefined],
  ] as const;
  return <EmptyState icon="sparkle" title={tr('library.firstSongTitle')} description={tr('library.noSongsBody')}
    action={<Stack direction="row" gap={3} justify="center" wrap>
      {buttons.map(([onClick, icon, label, variant]) => <Button key={label} size="lg" icon={icon}
        variant={variant} label={tr(label)} onClick={onClick} />)}
    </Stack>} />;
};
