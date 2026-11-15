import { bridgedHttp } from './desktopBridge';

export interface YoutubeRadioTrack {
  playlistId: string;
  playlistTitle: string;
  index: number;
  count: number;
  id: string;
  title: string;
  artist: string;
  url: string;
}

export const resolveYoutubeRadio = (playlistId: string, index: number) =>
  bridgedHttp<YoutubeRadioTrack>(
    'pythonRequest',
    {
      method: 'GET',
      path: `/radio/youtube?playlist_id=${encodeURIComponent(playlistId)}&index=${index}`,
    },
    'YouTube playlist unavailable',
  );
