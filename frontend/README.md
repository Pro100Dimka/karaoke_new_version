# A&D Voice Frontend

## Чистая установка

Установите Node.js 22.12 или новее. Из папки `frontend` запустите `npm ci`: команда установит зависимости из lock-файла, включая выпущенную версию `@neo-ui-kit/react`, и загрузит исполняемый файл Electron. Для проверки сборки запустите `npm run build`. Нужен доступ к GitHub Releases, откуда скачивается UI-кит. Python Backend и AudioService устанавливаются отдельно; `npm ci` относится только к frontend.

Рабочий desktop-клиент на React + TypeScript + Electron + Vite и `@neo-ui-kit/react`. Формы используют `useForm` из UI-кита; иконки — его `Icon` и строковые имена. Локального `src/theme/ui`, Formik и прямой зависимости `lucide-react` в текущем приложении нет. Версии зависимостей фиксируются в `package.json` и lock-файле.

## Рабочий запуск и проверки

Из корня репозитория: `start.bat dev` для Vite hot reload renderer, `start.bat` для собранного приложения. Изменения Electron, Python и AudioService требуют перезапуска; уже работающее окно сначала закрывают обычным способом. Для обычных функций достаточно одного окна. Комнатные сценарии запускаются через `start-multy.bat` по обязательным правилам корневого `AGENTS.md`.

`check.bat frontend` запускает полный набор frontend-проверок, `check.bat frontend <путь к тесту>` — только промежуточную целевую проверку. Для изменений нескольких подсистем используется `check.bat all`. Browser/Electron, реальные аудиоустройства и room E2E проверяются отдельно, когда затронуты соответствующие сценарии; успешные unit-тесты их не заменяют.

## Документы

- `docs/Frontend-project-spec.md` — нормативное полное описание продукта, экранов, состояний, lifecycle, Library, Karaoke, Melody Editor, Settings, Recording, Processing, Online Room, recovery, persistence и desktop behaviour.
- `docs/Frontend-screen-map.md` — карта routes, modal/overlay surfaces и layer priority.
- `docs/Frontend-user-flows.md` — канонические end-to-end пользовательские сценарии.
- `docs/Frontend-content-catalog.md` — используемые icons/assets/media и их точное назначение.
- `docs/Frontend-technology-contract.md` — текущий стек, UI-кит и typed boundaries Python Backend / AudioService / Electron.

## Assets

В `src/assets/` находятся theme previews, karaoke backgrounds и room sounds; лицензия фоновой сцены — в `src/app/backdrop/`.

## Важный contract title bar

`Minus`, `Maximize2`/Restore и `X` всегда находятся **выше всего приложения** — выше страниц, Settings, popovers, dialogs, confirmation/critical modals, room dock, processing surfaces и blackout. Они остаются видимыми и кликабельными даже в Karaoke fullscreen. Modal backdrops, focus traps и drag-region не могут перехватывать их pointer input.

## Статус

Описания актуализированы по рабочему дереву 23.10.2026. Они не являются отчётом об успешном прохождении всех проверок. Статус и границы документов описаны в `docs/SPEC-STATUS.md`; обязательные архитектурные и live-gates из `AGENTS.md` сохраняются.

- `docs/Frontend-system-responsibility-map.md` — каноническая карта владельцев функций React / Electron Main / Python Backend / AudioService.

## Зафиксированные решения v1

- Отдельный A&D Voice logo/wordmark asset не используется; product name отображается текстом с канонической typography.
- Karaoke принимает только `KaraokeOpenMode::{Normal, AutoStart, RoomPrepared}`; произвольного route intent нет.
- Application self-update отсутствует в v1: приложение не проверяет, не предлагает, не скачивает и не устанавливает обновления. `Model Update Available` относится только к AI-моделям.

## Technology lock

- Production application code: TypeScript (`.ts` / `.tsx`).
- JavaScript не используется для нового application logic.
- Python Backend и AudioService работают отдельными процессами с typed/versioned public contracts; их готовность подтверждают собственные проверки.
