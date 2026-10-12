import type { roomDockEn } from "./messages.en.roomDock";

// Ukrainian texts of the room panel.
export const roomDockUk = {
  roomActions: "Дії кімнати",
  roomDetach: "В окреме вікно",
  transferLabel: "Передача проєкту",
  roomProjectTransferFailed: "Не вдалося підготувати проєкт. Повторіть завантаження.",
  roomParticipantTransferFailed: "Учасник не зміг підготувати проєкт. Він може повторити завантаження.",
  transferRemaining: "Залишилось ~ {minutes} хв",
  transferRemainingSoon: "Залишилось менше хвилини",
  roomLatencyLabel: "Затримка",
  linkExcellent: "Відмінно",
  linkGood: "Добре",
  linkHigh: "Висока",
  linkUnstable: "Нестабільно",
  linkOverloaded: "Перевантаження",
  muteMicrophone: "Вимкнути мій мікрофон",
  unmuteMicrophone: "Увімкнути мій мікрофон",
  muteParticipant: "Заглушити {name} у мене",
  unmuteParticipant: "Знову чути {name}",
  guestBadge: "GUEST",
} satisfies Record<keyof typeof roomDockEn, string>;
