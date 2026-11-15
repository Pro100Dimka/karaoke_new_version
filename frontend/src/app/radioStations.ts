interface RadioStation {
  id: string;
  name: string;
  url: string;
  genre: string;
}

export const youtubeSource = (id: string) => {
  const match = /^youtube:([A-Za-z0-9_-]{10,100}):([1-9]\d{0,5})$/.exec(id);
  const playlistId = match?.[1];
  const index = Number(match?.[2]);
  return playlistId && Number.isInteger(index) && index <= 100_000
    ? { playlistId, index }
    : null;
};

export const youtubeSourceFromUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    const playlistId = url.searchParams.get('list');
    const index = Number(url.searchParams.get('index') || 1);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      ![
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be',
      ].includes(url.hostname) ||
      !playlistId ||
      !/^[A-Za-z0-9_-]{10,100}$/.test(playlistId) ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > 100_000
    )
      return null;
    return `youtube:${playlistId}:${index}`;
  } catch {
    return null;
  }
};

export const radioStations: readonly RadioStation[] = [
  {
    id: 'groove-salad',
    name: 'SomaFM · Groove Salad',
    url: 'https://ice6.somafm.com/groovesalad-128-mp3',
    genre: 'Downtempo · Chill',
  },
  {
    id: 'secret-agent',
    name: 'SomaFM · Secret Agent',
    url: 'https://ice6.somafm.com/secretagent-128-mp3',
    genre: 'Lounge · Grooves',
  },
  {
    id: 'radio-paradise',
    name: 'Radio Paradise',
    url: 'https://stream.radioparadise.com/mp3-128',
    genre: 'Rock · Indie · Eclectic',
  },
  {
    id: 'kiss-fm',
    name: 'KISS FM',
    genre: 'Dance · EDM',
    url: 'https://tavr.tvstitch.com/KissFM_HD',
  },
  {
    id: 'kiss-deep',
    name: 'KISS FM Deep',
    genre: 'Deep House',
    url: 'https://tavr.tvstitch.com/KissFM_Deep_HD',
  },
  {
    id: 'kiss-digital',
    name: 'KISS FM Digital',
    genre: 'Electronic · Club',
    url: 'https://tavr.tvstitch.com/KissFM_Digital_HD',
  },
  {
    id: 'kiss-ukr',
    name: 'KISS FM Ukrainian',
    genre: 'Ukrainian Dance',
    url: 'https://tavr.tvstitch.com/KissFM_Ukr_HD',
  },
  {
    id: 'radio-roks',
    name: 'Radio ROKS',
    genre: 'Rock',
    url: 'https://online.radioroks.ua/RadioROKS_HD',
  },
  {
    id: 'roks-heavy',
    name: 'Radio ROKS Hard’n’Heavy',
    genre: 'Hard Rock · Metal',
    url: 'https://tavr.tvstitch.com/RadioROKS_HardnHeavy_HD',
  },
  {
    id: 'roks-new',
    name: 'Radio ROKS Новий Рок',
    genre: 'Alternative · Modern Rock',
    url: 'https://tavr.tvstitch.com/RadioROKS_NewRock_HD',
  },
  {
    id: 'roks-ukr',
    name: 'Radio ROKS Український Рок',
    genre: 'Ukrainian Rock',
    url: 'https://tavr.tvstitch.com/RadioROKS_Ukr_HD',
  },
  {
    id: 'hit-fm',
    name: 'Хіт FM',
    genre: 'Pop · Hits',
    url: 'https://tavr.tvstitch.com/HitFM_HD',
  },
  {
    id: 'power-181',
    name: '181.FM Power 181',
    genre: 'Pop · Top 40',
    url: 'https://listen.181fm.com/181-power_128k.mp3',
  },
  {
    id: 'beat-181',
    name: '181.FM The Beat',
    genre: 'Hip-Hop · R&B',
    url: 'https://listen.181fm.com/181-beat_128k.mp3',
  },
  {
    id: 'dance-wave',
    name: 'Dance Wave!',
    genre: 'Dance · House · Trance',
    url: 'https://dancewave.online/dance.mp3',
  },
  {
    id: 'dance-retro',
    name: 'Dance Wave Retro!',
    genre: '90s · Eurodance',
    url: 'https://dancewave.online/retrodance.mp3',
  },
  {
    id: 'the-trip',
    name: 'SomaFM · The Trip',
    genre: 'Progressive · Trance',
    url: 'https://ice6.somafm.com/thetrip-128-mp3',
  },
  {
    id: 'dubstep-beyond',
    name: 'SomaFM · Dub Step Beyond',
    genre: 'Dubstep · Bass',
    url: 'https://ice6.somafm.com/dubstep-128-mp3',
  },
  {
    id: 'beat-blender',
    name: 'SomaFM · Beat Blender',
    genre: 'Deep House · Beats',
    url: 'https://ice6.somafm.com/beatblender-128-mp3',
  },
  {
    id: 'radio-jazz',
    name: 'Radio Jazz',
    genre: 'Jazz · Soul',
    url: 'https://online.radiojazz.ua/RadioJazz_HD',
  },
];
