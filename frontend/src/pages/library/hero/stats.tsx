import { observer } from 'mobx-react-lite';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { store } from '../../../providers/store';
import { useJobs } from '../../../providers/application';
import { songsQuery, songSummaryQuery } from '../../../api/api-service';
import { mergeRoomLibrary } from '../../../application/room/roomLibrary';
import type { SongDto } from '../../../contracts/models';
import { Grid, StatTile, tr } from '@neo-ui-kit/react';
import { FriendsStat } from './friends-stat';
import { isInQueue } from '../modals/processing/processingModel';

const LibraryStats = observer(({ onOpenProcessing }: { onOpenProcessing(): void }) => {
  const epoch = store.application.services.pythonEpoch;
  const { data } = useInfiniteQuery({ ...songsQuery(epoch), enabled: false });
  const { data: summary } = useQuery(songSummaryQuery(epoch));
  const { room } = store.online;
  const selfId = room?.participants.find((person) => person.self)?.id ?? '';
  const { data: imports = [] } = useQuery<readonly SongDto[]>({
    queryKey: ['song-imports'],
    enabled: false,
  });
  const { jobs } = useJobs();
  const activeJobs = jobs.filter(isInQueue);
  const active = new Set(activeJobs.map((job) => job.songId));
  const local = (
    room
      ? [...imports, ...(data?.pages.flatMap((page) => page.items) ?? [])]
      : []
  ).map((song) =>
    active.has(song.id) ? { ...song, status: 'processing' as const } : song,
  );
  const songs = mergeRoomLibrary(local, room?.sharedSongs ?? [], selfId);
  const complete = !!room && !!data;
  const songCount = complete ? songs.length : (summary?.total ?? '—');
  const readyCount = complete
    ? songs.filter((song) => song.status === 'ready').length
    : (summary?.ready ?? '—');
  return (
    <Grid
      columns={{ base: 1, sm: 3 }}
      gap={4}
      style={{ flex: 1, alignSelf: 'start' }}
    >
      <StatTile
        icon="music"
        value={songCount}
        label={tr('totalSongs')}
        tilt={false}
      />
      <StatTile
        icon="mic"
        value={readyCount}
        label={tr('readyForKaraoke')}
        aria-label={`${tr('readyForKaraoke')} · ${tr('processingQueue')}`}
        aria-haspopup="dialog"
        tilt={false}
        badge={activeJobs.length || undefined}
        badgeLabel={tr('processingQueue')}
        onClick={() => onOpenProcessing()}
      />
      <FriendsStat />
    </Grid>
  );
});
export default LibraryStats;
