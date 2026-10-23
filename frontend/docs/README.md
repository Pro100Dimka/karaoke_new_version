# Документация A&D Voice Frontend

Документы описывают существующий frontend на React + TypeScript + Electron + Vite + `@neo-ui-kit/react`. Формы используют kit `useForm`, иконки — kit `Icon`. Описания поведения сверены с рабочим деревом 23.10.2026; состояние проверок не следует выводить из наличия описанного сценария (см. [SPEC-STATUS.md](SPEC-STATUS.md)).

## Документы

- [Frontend-project-spec.md](Frontend-project-spec.md) — продукт, экраны, обработка, караоке, редактор, записи, настройки и lifecycle.
- [Frontend-screen-map.md](Frontend-screen-map.md) — routes, modal/overlay surfaces и layer priority.
- [Frontend-user-flows.md](Frontend-user-flows.md) — пользовательские сценарии, включая пересчёт и очистку очереди.
- [Frontend-content-catalog.md](Frontend-content-catalog.md) — icons/assets/media и их назначение.
- [Frontend-technology-contract.md](Frontend-technology-contract.md) — текущий стек и typed boundaries сервисов.
- [Frontend-system-responsibility-map.md](Frontend-system-responsibility-map.md) — владельцы функций React / Electron / Python / AudioService / Room Server.

## Assets

Файлы изображений и звуков находятся в `../src/assets/`, лицензия фоновой сцены — в `../src/app/backdrop/`.

## Важный contract title bar

`Minus`, `Maximize2`/Restore и `X` всегда находятся **выше всего приложения** — выше страниц, Settings, popovers, dialogs, confirmation/critical modals, room dock, processing surfaces и blackout. Они остаются видимыми и кликабельными даже в Karaoke fullscreen. Modal backdrops, focus traps и drag-region не могут перехватывать их pointer input.

## Статус

Запуск и команды проверок определяет [корневой AGENTS.md](../../AGENTS.md). Описания продукта не отменяют требования к архитектуре, регрессионным тестам, аппаратным и комнатным проверкам.

## Зафиксированные решения v1

- Отдельный A&D Voice logo/wordmark asset не используется; product name отображается текстом с канонической typography.
- Karaoke принимает только `KaraokeOpenMode::{Normal, AutoStart, RoomPrepared}`; произвольного route intent нет.
- Application self-update отсутствует в v1: приложение не проверяет, не предлагает, не скачивает и не устанавливает обновления. `Model Update Available` относится только к AI-моделям.

## Technology lock

- Production application code: TypeScript (`.ts` / `.tsx`).
- JavaScript не используется для нового application logic.
- Python Backend и AudioService работают отдельными процессами с typed/versioned public contracts; их готовность подтверждают собственные проверки.
