import type { roomDockEn } from "./messages.en.roomDock";

// Russian texts of the room panel.
export const roomDockRu = {
  roomEyebrow: "Комната",
  roomActions: "Действия комнаты",
  roomDetach: "В отдельное окно",
  transferLabel: "Передача проекта",
  transferRemaining: "Осталось ~ {minutes} мин",
  transferRemainingSoon: "Осталось меньше минуты",
  roomSongLabel: "Песня",
  roomNoSong: "Песня пока не выбрана",
  roomLatencyLabel: "Задержка",
  linkExcellent: "Отлично",
  linkGood: "Хорошо",
  linkHigh: "Высокая",
  linkUnstable: "Нестабильно",
  linkOverloaded: "Перегрузка",
  muteMicrophone: "Выключить мой микрофон",
  unmuteMicrophone: "Включить мой микрофон",
  muteParticipant: "Заглушить {name} у меня",
  unmuteParticipant: "Снова слышать {name}",
  roomYouSpeaking: "Говорите…",
  roomParticipantListening: "Слушает…",
  hostBadge: "HOST",
  guestBadge: "GUEST",
} satisfies Record<keyof typeof roomDockEn, string>;
