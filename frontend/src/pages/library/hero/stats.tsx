import { observer } from "mobx-react-lite";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { store } from "../../../providers/store";
import { useJobs } from "../../../providers/application";
import { songsQuery, songSummaryQuery } from "../../../api/api-service";
import { mergeRoomLibrary } from "../../../application/room/roomLibrary";
import type { SongDto } from "../../../contracts/models";
import { Grid, StatTile, tr } from '@neo-ui-kit/react';
import { FriendsStat } from './friends-stat';
import { ru } from '../../../i18n/messages.ru';

const LibraryStats = observer(() => {
  const epoch = store.application.services.pythonEpoch;
  const { data } = useInfiniteQuery({ ...songsQuery(epoch), enabled: false });
  const { data: summary } = useQuery(songSummaryQuery(epoch));
  const { room } = store.online;
  const selfId = room?.participants.find(person => person.self)?.id ?? "";
  const { data: imports = [] } = useQuery<readonly SongDto[]>({ queryKey: ["song-imports"], enabled: false });
  const { jobs } = useJobs();
  const active = new Set(jobs.filter(job => ["queued", "processing", "cancelling"].includes(job.state)).map(job => job.songId));
  const local = (room ? [...imports, ...(data?.pages.flatMap(page => page.items) ?? [])] : [])
    .map(song => active.has(song.id) ? { ...song, status: "processing" as const } : song);
  const songs = mergeRoomLibrary(local, room?.sharedSongs ?? [], selfId);
  const complete = !!room && !!data;
  const songCount = complete ? songs.length : summary?.total ?? "—";
  const readyCount = complete ? songs.filter(song => song.status === "ready").length : summary?.ready ?? "—";
  return (
  <Grid columns={{ base: 1, sm: 3 }} gap={4} style={{ flex: 1, alignSelf: 'start' }}>
    {[
      { icon: 'music', value: songCount, label: ru.totalSongs },
      { icon: 'mic', value: readyCount, label: ru.readyForKaraoke },
    ].map(({ label, ...tile }) => <StatTile key={tile.icon} {...tile} label={tr(label)} tilt={false} />)}
    <FriendsStat />
  </Grid>
  );
});
export default LibraryStats;
