import { Grid, StatTile, tr } from '@neo-ui-kit/react';
import { FriendsStat } from './friends-stat';
import { ru } from '../../../i18n/messages.ru';

const LibraryStats = ({ songCount, readyCount }: { songCount: number | string; readyCount: number | string }) => (
  <Grid columns={{ base: 1, sm: 3 }} gap={4} style={{ flex: 1, alignSelf: 'start' }}>
    {[
      { icon: 'music', value: songCount, label: ru.totalSongs },
      { icon: 'mic', value: readyCount, label: ru.readyForKaraoke },
    ].map(({ label, ...tile }) => <StatTile key={tile.icon} {...tile} label={tr(label)} tilt={false} />)}
    <FriendsStat />
  </Grid>
);
export default LibraryStats;
