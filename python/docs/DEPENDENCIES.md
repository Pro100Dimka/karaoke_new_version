# Обоснование зависимостей (pack_rules.md, п. 45–46, 78–81)

`requirements.lock` — воспроизводимая установка (`pip install -r requirements.lock`), получена `pip freeze` из проверенного окружения.
Прямые зависимости объявлены в `pyproject.toml`; всё, что импортируется напрямую, — прямая зависимость.

| Зависимость | Задача | Почему не stdlib / другое | Граница |
|---|---|---|---|
| fastapi, starlette, uvicorn | локальный HTTP/SSE API из ТЗ (§17) | в stdlib нет ASGI/валидации схем; starlette импортируется напрямую (`TestClient`, streaming) | только `backend/api` |
| pydantic | API DTO и валидация входа (ТЗ §9, §211) | собственный validation framework запрещён (п. 34) | только `backend/api` |
| sqlalchemy | SQLite persistence (ТЗ §152) | собственный ORM запрещён (п. 33) | только `backend/infrastructure` |
| torch (extra `ai`) | AI/CUDA; единственный ML runtime (п. 24) | нужен для separation/ASR/pitch | только AI infrastructure, lazy-import |
| demucs, openai-whisper, torchcrepe, torchaudio, uroman (extra `ai`) | локальный AI-провайдер `local-torch`: разделение голоса и музыки (HTDemucs), распознавание речи и тайминги слов (Whisper base, uk/ru/en), высота тона (CREPE), принудительное выравнивание текста по вокалу до каждой буквы (MMS-FA, символьный CTC из torchaudio; uroman переводит любой алфавит в латиницу для модели) | собственные модели писать нельзя (п. 33); все три работают на torch — второй ML runtime не добавляется (п. 24); веса Demucs, Whisper и MMS-FA скачиваются штатным механизмом моделей приложения с проверкой размера и sha256 (`backend/ai/catalog.py`), веса CREPE входят в пакет | только отдельный процесс `backend/ai_worker` (не API-процесс) |
| pytest, httpx, ruff, mypy (extra `dev`) | тесты и статический контроль | не входят в runtime/installer (п. 89–90) | dev-only |

Остальное (json, zipfile, hashlib, subprocess, sqlite3, threading, wave и т. д.) закрывается стандартной библиотекой.
Обновление major-версий — отдельным изменением с прогоном `scripts/run_checks.py --require-dev-tools`.

Транзитивные зависимости AI-воркера (librosa, soundfile, numba, scipy, einops, julius и др.) фиксируются в `requirements.lock`. Воркер запускается командой `python -m backend.ai_worker <action>` и общается с бэкендом JSON по stdout (UTF-8); без установленного extra `ai` провайдер не регистрируется, а обработка возвращает `AiProviderUnavailable`.
