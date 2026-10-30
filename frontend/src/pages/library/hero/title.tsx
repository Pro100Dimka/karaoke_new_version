import { GlowText, ImageShine, Stack, tr, Typography } from '@neo-ui-kit/react';
import { observer } from 'mobx-react-lite';
import { store } from '../../../providers/store';
import { appThemes } from '../../../providers/theme/variants';
import { ru } from '../../../i18n/messages.ru';

const LibraryTitle = observer(({ titleId }: { titleId: string }) => (
  <Stack direction="row" align="center" gap={6}>
    <ImageShine src={appThemes[store.interface.theme].icon} style={{ flex: 1 }} />
    <Stack gap={2} style={{ flex: 8 }}>
      <Typography variant="eyebrow" tone="accent" text={tr(ru.yourMusicCollection)} />
      <Typography variant="display" as="h1" id={titleId}>
        <GlowText>A&amp;D Voice</GlowText>
      </Typography>
      <Typography tone="muted" text={tr(ru.libraryTagline)} />
    </Stack>
  </Stack>
));
export default LibraryTitle;
