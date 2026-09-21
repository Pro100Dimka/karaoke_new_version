# A&D Voice Frontend — полная product specification с нуля

Этот архив описывает **сам frontend-продукт**, создаваемый полностью с нуля на React + TypeScript + Electron + Vite + Theme UI kit (`src/theme/ui`) + Formik. Он не является migration/refactor plan, не предполагает существование старого frontend, не содержит архитектурных/code rules и не является implementation plan.

## Документы

- `docs/Frontend-project-spec.md` — нормативное полное описание продукта, экранов, состояний, lifecycle, Library, Karaoke, Melody Editor, Settings, Recording, Processing, Online Room, recovery, persistence и desktop behaviour.
- `docs/Frontend-screen-map.md` — карта routes, modal/overlay surfaces и layer priority.
- `docs/Frontend-user-flows.md` — канонические end-to-end пользовательские сценарии.
- `docs/Frontend-content-catalog.md` — используемые icons/assets/media и их точное назначение.
- `docs/Frontend-technology-contract.md` — канонический стек React + TypeScript + Electron + Vite + Theme UI kit (`src/theme/ui`) + Formik и строгие typed boundaries Python Backend / AudioService / Electron.

## Assets

В `assets/` включён канонический visual/audio content pack нового проекта, на который ссылается specification: theme previews, karaoke backgrounds, room sound и лицензия QFT asset.

## Важный contract title bar

`Minus`, `Maximize2`/Restore и `X` всегда находятся **выше всего приложения** — выше страниц, Settings, popovers, dialogs, confirmation/critical modals, room dock, processing surfaces и blackout. Они остаются видимыми и кликабельными даже в Karaoke fullscreen. Modal backdrops, focus traps и drag-region не могут перехватывать их pointer input.

## Статус

Эта версия закрывает продуктовые решения без `if supported`/`where applicable` для внутренних функций v1. Если поведение зависит от внешнего hardware/backend, specification описывает конкретные observable состояния `Supported/Unsupported` и recovery UX.

- `docs/Frontend-system-responsibility-map.md` — каноническая карта владельцев функций React / Electron Main / Python Backend / AudioService.


## Зафиксированные решения v1

- Отдельный A&D Voice logo/wordmark asset не используется; product name отображается текстом с канонической typography.
- Karaoke принимает только `KaraokeOpenMode::{Normal, AutoStart, RoomPrepared}`; произвольного route intent нет.
- Application self-update отсутствует в v1: приложение не проверяет, не предлагает, не скачивает и не устанавливает обновления. `Model Update Available` относится только к AI-моделям.

## Technology lock

- Production application code: TypeScript (`.ts` / `.tsx`).
- JavaScript не используется для нового application logic.
- Python Backend и AudioService считаются готовыми внешними системами с typed/versioned public contracts.
