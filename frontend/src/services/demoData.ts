import type { ParticipantDto, SongDto } from "../contracts/models";

export const demoSongs: readonly SongDto[] = [
  {
    id: "boombox-people",
    title: "Люди",
    artist: "Бумбокс",
    genre: "Rock",
    filename: "liudy.flac",
    status: "ready",
    difficulty: "medium",
    durationSeconds: 246,
    projectFormatVersion: 1,
    recordingsCount: 3
  },
  {
    id: "antytila-tdme",
    title: "Там, де ми є",
    artist: "Антитіла",
    genre: "Pop Rock",
    filename: "tam_de_my_ie.mp3",
    status: "ready",
    difficulty: "hard",
    durationSeconds: 229,
    projectFormatVersion: 1,
    recordingsCount: 1
  },
  {
    id: "okean-nebo",
    title: "Без бою",
    artist: "Океан Ельзи",
    genre: "Rock",
    filename: "bez_boiu.wav",
    status: "processing",
    difficulty: "medium",
    durationSeconds: 258,
    progress: 64,
    stage: "Lyrics alignment",
    recordingsCount: 0
  },
  {
    id: "hardkiss-zho",
    title: "Журавлі",
    artist: "The Hardkiss",
    genre: "Alternative",
    filename: "zhuravli.flac",
    status: "not-processed",
    difficulty: "hard",
    durationSeconds: 232,
    recordingsCount: 0
  },
  {
    id: "onuka-zenit",
    title: "ZENIT",
    artist: "ONUKA",
    genre: "Electronic",
    filename: "zenit.mp3",
    status: "failed",
    difficulty: "medium",
    durationSeconds: 219,
    recordingsCount: 0
  },
  {
    id: "kazka-plakala",
    title: "Плакала",
    artist: "KAZKA",
    genre: "Pop",
    filename: "plakala.m4a",
    status: "invalid",
    difficulty: "easy",
    durationSeconds: 226,
    projectFormatVersion: 0,
    recordingsCount: 0
  }
];

export const demoParticipants: readonly ParticipantDto[] = [
  {
    id: "me",
    name: "Dim",
    role: "host",
    self: true,
    muted: false,
    speakingLevel: 0.42,
    volume: 1,
    readiness: "ready"
  },
  {
    id: "anna",
    name: "Anna",
    role: "participant",
    self: false,
    muted: false,
    speakingLevel: 0.72,
    volume: 0.86,
    readiness: "ready"
  },
  {
    id: "max",
    name: "Max",
    role: "participant",
    self: false,
    muted: true,
    speakingLevel: 0.02,
    volume: 0.7,
    readiness: "downloading"
  }
];
