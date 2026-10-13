import type { roomDockEn } from "./messages.en.roomDock";

// Russian texts of the room panel.
export const roomDockRu = {
  roomActions: "Действия комнаты",
  roomDetach: "В отдельное окно",
  transferLabel: "Передача проекта",
  roomProjectTransferFailed: "Не удалось подготовить проект. Повторите загрузку.",
  roomParticipantTransferFailed: "Участник не смог подготовить проект. Он может повторить загрузку.",
  transferRemaining: "Осталось ~ {minutes} мин",
  transferRemainingSoon: "Осталось меньше минуты",
  roomLatencyLabel: "Задержка",
  linkExcellent: "Отлично",
  linkGood: "Хорошо",
  linkHigh: "Высокая",
  linkUnstable: "Нестабильно",
  linkOverloaded: "Перегрузка",
  muteMicrophone: "Выключить мой микрофон",
  unmuteMicrophone: "Включить мой микрофон",
  guestBadge: "GUEST",
} satisfies Record<keyof typeof roomDockEn, string>;
