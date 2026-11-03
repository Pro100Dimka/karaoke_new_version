export const roomRu = {
  participantJoined: '{name} присоединился',
  participantLeft: '{name} вышел',
  roomClosed: 'Комната закрыта',
  roomNetworkUnavailable:
    'Сеть недоступна. Локальные функции продолжают работать.',
  roomProjectConflict: 'У вас другая версия этой песни. Ваша копия сохранена.',
  roomReplaceProject: 'Заменить версией хоста',
  roomReconnecting: 'Восстановление связи с комнатой…',
  roomCheckSync: 'Проверить синхронизацию',
  roomSyncResult: 'Оценка задержки голосов',
  roomSyncEstimateHint:
    'Задержка воспроизведения задаётся для комнаты. Пинг — отдельное измерение пути до сервера и обратно.',
  roomQualityClose:
    'Как в одной комнате: все слышат друг друга с задержкой {ms} мс',
  roomQualityFollower:
    'Вы поёте в такт с ведущим: ваша музыка сдвинута на {ms} мс',
  roomQualitySynchronized:
    'Серверная синхронизация: все слышат одну временную линию с защитной задержкой {ms} мс',
  roomQualityNoticeable:
    'Остальных вы слышите на {ms} мс позже: заметно, но петь можно',
  roomQualityFar:
    'Большая задержка голосов ({ms} мс), заметная при совместном пении.',
  roomPing: 'Пинг',
  roomJitter: 'Джиттер',
  roomRoute: 'Путь',
  roomRouteDirect: 'напрямую',
  roomRouteRelay: 'через сервер',
  roomDeviceStarving:
    'Звуковая карта этого компьютера не успевает, звук хрипит. Увеличьте буфер в настройках звука.',
  roomUnstableLink:
    'Обнаружены пропуски при передаче или воспроизведении голоса. Проверьте соединение, нагрузку и аудиобуфер.',
  roomTimingDetails: 'Что означает задержка',
  roomSyncClicksHint:
    'Через три секунды у всех прозвучат четыре общих контрольных щелчка',
  hostLeavingTitle: 'Вы хост комнаты',
  hostLeavingBody:
    'При выходе роль хоста перейдёт участнику, который вошёл раньше остальных.',
  transferHost: 'Передать роль хоста и выйти',
  transferHostAction: 'Сделать {name} хостом',
  closeRoom: 'Закрыть комнату',
  removeParticipant: 'Исключить {name}',
  removeParticipantTitle: 'Исключить участника?',
  removeParticipantBody:
    '{name} покинет комнату и сможет вернуться только после повторного входа.',
  removedFromRoom: 'Вас исключили из комнаты.',
  cancelTransfer: 'Отменить загрузку',
  retryTransfer: 'Повторить загрузку',
  roomCodePasteHint: 'Вставьте код от друга — войдёте сразу',
} as const;
