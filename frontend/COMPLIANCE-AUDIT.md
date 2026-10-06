# Frontend: сверка с docs (статус реализации)

Источник требований: `docs/frontend/docs/*` (Frontend-project-spec, screen-map, user-flows, content-catalog,
technology-contract, system-responsibility-map). Этот файл — фактический статус кода, а не копия спецификации.

## Проверено автоматически

- `npm run typecheck`, `npm run check:rules`, `npx vitest run` (60+ файлов), `npm run build`, `npm run electron:compile`.
- Playwright (Edge, scripted `window.desktop`): Library → Karaoke с реальными lyrics, Editor рендерится без
  renderer-ошибок, системные кнопки окна кликабельны поверх открытого modal.
- Electron запускается целиком (Python + AudioService + окно) и проверяется через CDP: настройки аудио, радио, формы, лоадер/splash, Library, Karaoke (play/pause/позиция), запись голоса, импорт и обработка настоящей песни.

## Реализовано по спецификации

| Область                                                                                                                                                                                                                                                                                                                | Разделы spec                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Bootstrap, раздельная доступность Python/AudioService, protocol mismatch, reconnect → свежие snapshots                                                                                                                                                                                                                 | 3, 83–85, 119, 163, 194                    |
| Title bar выше всего (z-index), fullscreen-режим кнопок, F11 в Karaoke, Restore label                                                                                                                                                                                                                                  | 5, 160, 185, 196                           |
| Preferences (theme, language, sort, display mode, gains, radio, audio devices, reduced motion), состояние окна                                                                                                                                                                                                         | 89, 157, 159, 160                          |
| Dialogs / transient notifications / close-guards (Settings, Editor, recording, processing, room)                                                                                                                                                                                                                       | 8, 129, 131, 180, 186                      |
| Library: debounce 150 мс, 4 сортировки + стабильный tie-break, virtualization, drag&drop, state/action matrix, delete confirm                                                                                                                                                                                          | 12–18, 132–136, 171, 183–184               |
| Processing Queue modal, cancel/retry, First Run, пустые состояния                                                                                                                                                                                                                                                      | 20, 130, 136, 172                          |
| Import: имя/формат/размер, ошибки по `code`                                                                                                                                                                                                                                                                            | 134                                        |
| Song Settings: title/artist/language/cover/video/default key/speed/range/format/status/действия                                                                                                                                                                                                                        | 169                                        |
| Recordings: `Take N · дата`, rename, open folder, delete confirm                                                                                                                                                                                                                                                       | 154, 175                                   |
| Karaoke: lifecycle (+Stopping), реальные lyrics/notes из проекта, позиция от AudioService, EOF → Finished + авто-stop записи, Recovering → Paused (без авто-play), video (muted, drift-sync), фоны по теме, display modes, режим без микрофона, блокировка seek/speed/key при записи, disk check, projectFormatVersion | 33–54, 138–143, 168, 187–189, 191–192, 195 |
| Melody Editor: drag/resize/multi-select/merge/delete/align, undo/redo, snapping, zoom, follow, dirty, draft recovery, conflict (Reload/Overwrite/Cancel), Restore, Ctrl+S/Z/Y/Delete/Space                                                                                                                             | 55–65, 144–146, 158                        |
| Settings: Immediate vs Apply-required, Requested vs Runtime, Device unavailable, mic privacy, AI models (size/disk/progress/cancel/retry), Storage (clear cache/temp), History (2 вкладки), Diagnostics (copy/export), About                                                                                           | 66–81, 147–148, 156, 162, 179              |
| Online Room: create/join, dock, общий каталог, exact-revision transfer/import, readiness gate, синхронный future start, late join, playback/shared-state sync, local voice gain, speaking waveform, reconnect indicator, collaborative control, явные transfer host/kick/close, раздельные join/leave chime            | 24–32, 149–153, 173–174                    |
| Radio: только Library, через AudioService, станция/громкость                                                                                                                                                                                                                                                           | 70, 177                                    |

## Известные расхождения со спецификацией (не сделано / ограничено)

0. **AI-модели**: встроенный провайдер `local-torch` (HTDemucs + Whisper base + CREPE) реализован в бэкенде; модели объявляются при старте и скачиваются из Settings → AI / Processing (проверено: скачивание и обработка песни до `Ready`). Более крупные/другие модели в каталог не добавлены.

Проверено по коду 2026-10-04; ранее перечисленные здесь пункты про обложки, поиск по имени файла, Live Pitch,
push-обновления комнаты, эффекты удалённого участника, отмену передачи проекта, определённые BPM/тональность,
статусы записей, прогресс и отмену импорта и подсветку клавиатуры (OpenRGB) уже реализованы и из списка убраны.

1. Список радиостанций (`app/radioStations.ts`) — предположение (в spec станции не перечислены).
2. `useKaraokeSession` (~410 строк) больше рекомендуемого размера хука; его стоит разделить отдельной задачей.
3. **Кнопки окна под модальным окном** (§5, 160, 185, 196): UI-кит открывает диалоги через нативный `showModal()`,
   поэтому, пока открыт диалог, остальной документ, включая кнопки «Свернуть/Развернуть/Закрыть», inert. Оставлено
   как известное ограничение (окно закрывается Alt+F4 или после закрытия диалога); e2e-тест помечен `fixme`.
4. Секретные ENV-значения (Kaggle, AudD, YouTube) только на запись: backend API их не возвращает, поле показывает
   «Сохранено», значение можно заменить или удалить, но не прочитать.

## Dependency: formik (forms)

The forms of the application (settings, add song, song settings, room, take rename) are rendered from typed row
configs by `theme/ui/GetForm` (the user's own form kit, ported from the previous project) on top of Formik.
Formik is kept instead of a hand-written form engine: it owns values, touched/error state, dirty tracking,
async validation and submit lifecycle, which the kit's `RenderFormikFields` binds to themed controls by path.
No schema library is added; rows use plain `validate` functions.
