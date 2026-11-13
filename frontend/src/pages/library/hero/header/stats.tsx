import { Grid, StatTile, tr } from '@neo-ui-kit/react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';

import { mergeRoomLibrary } from '../../../../application/room/roomLibrary';
import {
  songsQuery,
  songSummaryQuery,
} from '../../../../components/api-service';
import type { SongDto } from '../../../../contracts/models';
import { useJobs } from '../../../../providers/application';
import { store } from '../../../../providers/store';
import { FriendsDialog } from '../../modals/friends';
import { isInQueue } from '../../modals/processing/processingModel';

const LibraryStats = observer(
  ({ onOpenProcessing }: { onOpenProcessing(): void }) => {
    const { pythonEpoch } = store.application.services;
    const { room } = store.online;
    const { jobs } = useJobs();
    const { data: library } = useInfiniteQuery({
      ...songsQuery(pythonEpoch),
      enabled: false,
    });
    const { data: summary } = useQuery(songSummaryQuery(pythonEpoch));
    const { data: imports } = useQuery<readonly SongDto[]>({
      queryKey: ['song-imports'],
      enabled: false,
    });
    const activeJobs = jobs.filter(isInQueue);
    let total: number | string = summary?.total ?? '—';
    let ready: number | string = summary?.ready ?? '—';
    if (room && library) {
      const activeIds = new Set(activeJobs.map(({ songId }) => songId));
      const localSongs = [
        ...(imports ?? []),
        ...library.pages.flatMap(({ items }) => items),
      ].map((song) =>
        activeIds.has(song.id)
          ? { ...song, status: 'processing' as const }
          : song,
      );
      const selfId = room.participants.find(({ self }) => self)?.id ?? '';
      const songs = mergeRoomLibrary(
        localSongs,
        room.sharedSongs ?? [],
        selfId,
      );
      total = songs.length;
      ready = songs.filter(({ status }) => status === 'ready').length;
    }
    return (
      <Grid
        columns={{ base: 1, sm: 3 }}
        gap={4}
        style={{ flex: 1, alignSelf: 'start', height: 'stretch' }}
      >
        <StatTile
          icon="music"
          value={total}
          label={tr('totalSongs')}
          tilt={false}
        />
        <StatTile
          icon="mic"
          value={ready}
          label={tr('readyForKaraoke')}
          aria-label={`${tr('readyForKaraoke')} · ${tr('processingQueue')}`}
          aria-haspopup="dialog"
          badge={activeJobs.length || undefined}
          badgeLabel={tr('processingQueue')}
          onClick={onOpenProcessing}
          tilt={false}
        />
        <FriendsDialog />
      </Grid>
    );
  },
);

export default LibraryStats;
