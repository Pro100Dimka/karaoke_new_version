// Split out of messages.ru.ts, which sits at the file-size ceiling (see check-rules.mjs).
export const audioRu = {
  audioDevicesTitle: "Аудиоустройства и параметры",
  audioDevicesHint: "Настройте аудиосистему для стабильной и низкой задержки",
  audioMonitorTitle: "Мониторинг и уровень сигнала",
  audioMonitorHint: "Следите за задержкой, уровнем и входящим сигналом",
  estimatedLatencyTitle: "Расчётная задержка",
  audioLevels: "Уровни",
  microphoneKnob: "Микрофон",
  inputMonitoring: "Мониторинг входа",
  inputMonitoringHint: "Используйте наушники: колонки могут вызвать громкий визг обратной связи",
  acousticLatency: "Скрытая задержка",
  acousticLatencyUnmeasured: "не измерена",
  acousticLatencyMeasure: "Измерить",
  acousticLatencyMeasuring: "Измеряю…",
  acousticLatencyHint:
    "Поднесите наушник или динамик к микрофону: прозвучат три тихих сигнала. Результат нужен, чтобы в комнате петь синхронно",
  acousticLatencyMeasured: "Скрытая задержка: {value} мс",
  acousticLatencyUncertaintyHint:
    "Оценка относительно временных меток аудиосистемы. Она не определяет причину задержки. После смены аудиотракта повторите измерение.",
  acousticLatencyFailed: "Не удалось измерить задержку",
  asioSetupTitle: "ASIO-драйвер не найден",
  asioDriverOpenFailed: "Не удалось открыть выбранный ASIO-драйвер.",
  asioSetupConfigureTitle: "Настройка ASIO4ALL",
  asioSetupBody:
    "Программа не смогла открыть драйвер аудиоинтерфейса. Для встроенной звуковой карты можно установить ASIO4ALL — универсальный ASIO-драйвер для Windows.",
  asioSetupInstall: "Скачать и установить ASIO4ALL",
  asioSetupDownloading: "Скачиваю и проверяю установщик…",
  asioSetupLaunched:
    "Завершите установку в открывшемся окне. После этого программа обнаружит драйвер автоматически.",
  asioSetupCheck: "Проверить установку",
  asioSetupReady:
    "ASIO4ALL найден и выбран. Перезапустите программу, затем снова измерьте задержку.",
  asioSetupRestart: "Перезапустить программу",
  asioSetupConfigureBody:
    "Включите внутри ASIO4ALL используемые микрофон и наушники. Изменение применяется автоматически; затем проверьте выход кнопкой тестового звука.",
  asioSetupConfigure: "Настроить устройства",
  releaseAsioInBackground: "Освобождать ASIO в фоне",
  releaseAsioInBackgroundHint:
    "Когда программа неактивна, ASIO временно отключается и освобождает звук для других приложений.",
  asioSetupFailed: "Не удалось запустить установку: {reason}",
};
