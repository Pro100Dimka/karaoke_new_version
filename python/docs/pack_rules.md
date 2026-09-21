# Python Backend — правило выбора библиотек перед собственной реализацией

## 1. Главный принцип

Перед реализацией новой нетривиальной технической функции сначала проверить, существует ли уже подходящее решение.

Порядок:

```text
1. Точно определить задачу.
2. Проверить стандартную библиотеку Python.
3. Проверить уже установленные зависимости проекта.
4. Проверить официальные библиотеки используемых технологий.
5. Найти актуальные решения на PyPI / GitHub / официальной документации.
6. Сравнить несколько вариантов.
7. Сравнить библиотеку с собственной реализацией.
8. Только после этого выбрать подход.
```

---

## 2. Запрещено сразу писать свою реализацию

Нельзя:

```text
увидел задачу
→ сразу написал свой cache / retry / parser / queue / validator / scheduler
```

без проверки существующих решений.

---

## 3. Приоритет выбора

Всегда проверять в таком порядке:

```text
Python Standard Library
↓
уже подключённые зависимости
↓
официальная библиотека/framework capability
↓
зрелая внешняя библиотека
↓
маленькая собственная реализация
```

---

## 4. Сначала стандартная библиотека

Перед новой dependency проверить:

```text
pathlib
itertools
functools
collections
asyncio
concurrent.futures
subprocess
logging
json
sqlite3
tempfile
shutil
zipfile
hashlib
urllib
contextlib
dataclasses
enum
```

и другие стандартные модули.

---

## 5. Не ставить пакет ради того, что уже есть в Python

Например не подключать отдельную библиотеку только ради:

```text
grouping
retry в одном простом месте
path manipulation
temporary files
simple caching
simple batching
```

если стандартная библиотека закрывает задачу чисто.

---

## 6. Проверять уже существующие зависимости

Перед:

```text
pip install
```

проверить, не решает ли задачу уже установленный пакет.

---

## 7. Не допускать дублирующие библиотеки

Без сильной причины нельзя иметь:

```text
две HTTP libraries
две validation libraries
две retry libraries
две ORM
две logging frameworks
```

для одной роли.

---

## 8. Для нетривиальной задачи интернет-поиск обязателен

Проверять:

```text
официальную документацию
PyPI
GitHub repository
issues
releases
maintenance status
```

---

## 9. Не выбирать первый найденный пакет

Для важной зависимости сравнить минимум несколько подходящих решений, если выбор существует.

---

## 10. Проверять актуальность

Оценивать:

```text
дату последних releases
поддерживаемые версии Python
активность maintainers
открытые critical issues
совместимость с Python 3.12+
```

---

## 11. Проверять зрелость

Смотреть:

```text
историю проекта
тесты
документацию
API stability
usage в экосистеме
```

---

## 12. Не выбирать только по количеству stars/downloads

Популярность — дополнительный сигнал, не критерий сама по себе.

---

## 13. Проверять license

До подключения убедиться, что license совместима с проектом и его распространением.

---

## 14. Проверять transitive dependencies

Одна маленькая dependency может притянуть десятки пакетов.

Это обязательно учитывать.

---

## 15. Проверять размер установки

Особенно для desktop-приложения.

Оценивать:

```text
wheel size
dependency tree
installer size
runtime size
```

---

## 16. Проверять startup/import cost

Некоторые Python packages сильно увеличивают startup time.

---

## 17. Проверять RAM cost

Особенно для:

```text
AI
data processing
native libraries
```

---

## 18. Проверять native code

Если пакет содержит:

```text
C
C++
Rust
CUDA
native DLL
```

это должно быть осознанно.

---

## 19. Проверять наличие Windows wheels

Для целевого Python/Windows x64.

---

## 20. Не выбирать пакет, который требует compiler на машине пользователя, если этого можно избежать

---

## 21. Предпочитать prebuilt wheels

Если проект должен просто устанавливаться у пользователя.

---

## 22. Проверять Python 3.12 support

Не подключать пакет, который фактически работает только на старом Python, если нет отдельной причины.

---

## 23. Для AI проверять CUDA compatibility

Например:

```text
PyTorch version
CUDA runtime
GPU support
wheel availability
```

---

## 24. Не добавлять второй крупный ML runtime без серьёзной причины

Например не тащить одновременно:

```text
PyTorch
TensorFlow
JAX
```

ради одной маленькой функции.

---

## 25. Проверять CPU fallback

Если capability должна работать без GPU.

---

## 26. Проверять provider requirements

Библиотека должна подходить под:

```text
CPU
RAM
GPU
VRAM
CUDA
Python version
Windows
```

---

## 27. Не выбирать библиотеку только потому, что она быстрее на конкретном твоём ПК

Решение должно быть универсальным.

---

## 28. Сравнивать по capabilities

Не:

```text
на RTX 3060 работает хорошо
```

а:

```text
supports CUDA
supports CPU
VRAM requirements
supported precision
```

---

## 29. Security-sensitive функции не писать самостоятельно без крайней причины

Предпочитать зрелые решения для:

```text
cryptography
authentication
archive security
HTML sanitization
protocol parsing
signature verification
```

---

## 30. Не писать собственную криптографию

---

## 31. Не писать собственный ZIP parser

Использовать стандартные/зрелые библиотеки и добавить собственную security validation policy.

---

## 32. Не писать собственный HTTP client

Если `httpx`/другая approved library уже используется и подходит.

---

## 33. Не писать собственный ORM

---

## 34. Не писать собственный schema validation framework

---

## 35. Не писать собственный task scheduler, если существующий простой механизм полностью подходит

Но и не ставить Celery ради двух локальных jobs без необходимости.

---

## 36. Размер решения должен соответствовать задаче

```text
маленькая задача
→ маленькое решение
```

---

## 37. Не ставить тяжёлый framework ради helper-функции

---

## 38. Когда библиотека предпочтительна

Если задача:

```text
сложная
стандартизированная
security-sensitive
имеет много edge cases
требует поддержки форматов/протоколов
```

---

## 39. Когда своя реализация предпочтительна

Если задача:

```text
маленькая
project-specific
понятная
несложная
может быть реализована в нескольких десятках строк
имеет ограниченный contract
```

---

## 40. Собственная реализация должна быть минимальной

Не превращать helper в внутренний framework.

---

## 41. Если свой код начал быстро расти — повторить поиск библиотек

Это обязательный trigger.

Например если implementation уже:

```text
сотни строк
много edge cases
много platform-specific кода
сложно тестируется
```

---

## 42. Сравнивать стоимость поддержки

Оценивать:

```text
свой код:
- написание
- тесты
- bugs
- edge cases
- maintenance

библиотека:
- updates
- API changes
- dependencies
- security
- license
```

---

## 43. Не считать dependency «бесплатной»

Любая dependency — это:

```text
обновления
уязвимости
breaking changes
installer size
compatibility risk
```

---

## 44. Не считать собственные 30 строк автоматически лучше библиотеки

Если эти 30 строк реализуют сложный протокол — библиотека обычно безопаснее.

---

## 45. Новая dependency требует justification

Кратко определить:

```text
какую задачу решает
почему stdlib недостаточно
почему существующие зависимости недостаточны
какие альтернативы рассмотрены
почему выбран этот пакет
```

---

## 46. Для крупной зависимости фиксировать ADR

Особенно если пакет влияет на:

```text
AI
database
networking
jobs
storage
```

---

## 47. Проверять API complexity

Если простая функция требует:

```text
registry
plugins
factory
global config
```

возможно, библиотека слишком тяжёлая.

---

## 48. Не тащить framework architecture в domain

Типы стороннего пакета не должны расползаться по всему backend, если это infrastructure detail.

---

## 49. Изолировать большую внешнюю библиотеку

Например:

```text
PyTorch
→ AI infrastructure

SQLAlchemy
→ persistence infrastructure

HTTP library
→ provider infrastructure
```

---

## 50. Domain не должен зависеть от library-specific types

---

## 51. Adapter нужен для стратегически важной внешней dependency

Если её замена или изоляция реально имеет смысл.

---

## 52. Не писать adapter механически вокруг каждой функции stdlib

---

## 53. Проверять thread/async compatibility

Особенно для FastAPI и background jobs.

---

## 54. Проверять blocking behavior

Пакет может блокировать event loop.

---

## 55. Не использовать sync-only heavy library прямо в async request handler

---

## 56. Проверять cancellation support

Для долгих операций это важно.

---

## 57. Проверять timeout support

---

## 58. Проверять streaming support

Для:

```text
downloads
large files
archives
HTTP
```

---

## 59. Не выбирать библиотеку, которая требует загрузить гигантский файл целиком в RAM, если нужен streaming

---

## 60. Проверять error model

Библиотека должна позволять нормально отличать:

```text
timeout
not found
invalid input
network error
```

---

## 61. Не протаскивать library exceptions через весь backend

Adapter переводит их в project errors.

---

## 62. Проверять observability

Можно ли получить:

```text
progress
errors
status
```

если это нужно продукту.

---

## 63. Проверять testability

Можно ли легко протестировать integration без реальной сети/GPU там, где нужно.

---

## 64. Не выбирать библиотеку, которую невозможно нормально fake/test при критичной логике

---

## 65. Проверять deterministic behavior

Если это важно для project generation/cache.

---

## 66. Проверять serialization compatibility

Если библиотека создаёт persistent format.

---

## 67. Не позволять сторонней библиотеке стать скрытым permanent format без нашего versioned contract

---

## 68. Проверять обновляемость

Что будет при переходе:

```text
v1 → v2
```

---

## 69. Проверять breaking-change frequency

---

## 70. Не pin-ить устаревшую библиотеку навечно ради старого API

Если замена реально нужна — мигрировать.

---

## 71. При замене библиотеки удалить старую

Порядок:

```text
подключить новую
→ перевести adapter/call sites
→ tests
→ удалить старую dependency
→ удалить compatibility code
```

---

## 72. Нельзя оставлять две библиотеки после завершения миграции

---

## 73. Не хранить fallback на старую dependency «на всякий случай»

---

## 74. Git хранит предыдущий вариант

---

## 75. Temporary dual dependency имеет removal condition

---

## 76. Проверять package health перед обновлением

Не обновлять major version автоматически без review.

---

## 77. Security updates имеют высокий приоритет

---

## 78. Lockfile/requirements должны фиксировать воспроизводимую установку

---

## 79. Не использовать полностью непиннутые production dependencies без policy

---

## 80. Direct dependencies должны быть явно известны

---

## 81. Не полагаться на transitive package как на свой прямой API

Если код импортирует package напрямую — он должен быть direct dependency.

---

## 82. Проверять dependency conflicts

Особенно:

```text
PyTorch
NumPy
CUDA
audio libraries
```

---

## 83. Не добавлять пакет, который ломает существующую dependency matrix без сильной причины

---

## 84. Проверять installer/build

Новая dependency должна пройти:

```text
clean install
build
packaging
Windows installer
```

---

## 85. Проверять offline install requirements

Если приложение должно работать после установки без интернета.

---

## 86. Runtime dependency не должна неожиданно требовать network

---

## 87. Model download library и runtime library — разные concerns

---

## 88. Не тянуть package в runtime, если он нужен только build/dev

---

## 89. Dev dependency отделять от runtime dependency

---

## 90. Не включать test tools в production installer без причины

---

## 91. Проверять import tree

Если импорт маленького module автоматически грузит:

```text
torch
huge native DLLs
```

это может ухудшить startup.

---

## 92. Heavy imports должны быть lazy where appropriate

---

## 93. Но lazy import не использовать для сокрытия circular architecture

---

## 94. Library evaluation должна учитывать startup cost

---

## 95. Библиотека должна соответствовать architecture boundaries

---

## 96. Нельзя выбирать библиотеку, которая заставляет сломать хороший domain design без серьёзной причины

---

## 97. Если библиотека требует global mutable singleton — оценить риск

---

## 98. Предпочитать explicit dependency injection

---

## 99. Не использовать package magic/import side effects как основной architecture mechanism

---

## 100. Финальный обязательный workflow

```text
Задача
↓
Проверить stdlib
↓
Проверить текущие dependencies
↓
Проверить официальные решения
↓
Поиск актуальных Python libraries
↓
Сравнить 2–3 варианта
↓
Проверить Windows / Python / license / size / maintenance / native dependencies
↓
Сравнить со своей реализацией
↓
Выбрать минимально сложное и надежное решение
↓
Зафиксировать причину выбора
↓
Реализовать
```

---

# Главное правило

```text
НЕ ПИСАТЬ СОБСТВЕННУЮ НЕТРИВИАЛЬНУЮ ИНФРАСТРУКТУРУ,
ПОКА НЕ ПРОВЕРЕНО,
ЧТО СУЩЕСТВУЮЩИЕ PYTHON-РЕШЕНИЯ
НЕ ПОДХОДЯТ ПРОЕКТУ.
```

И одновременно:

```text
НЕ ДОБАВЛЯТЬ НОВУЮ PYTHON DEPENDENCY,
ЕСЛИ STDLIB ИЛИ МАЛЕНЬКАЯ ПРОСТАЯ РЕАЛИЗАЦИЯ
РЕШАЕТ ЗАДАЧУ ЛУЧШЕ И С МЕНЬШЕЙ СЛОЖНОСТЬЮ.
```

---

# Короткая формула

```text
SEARCH
→ VERIFY
→ COMPARE
→ MEASURE COST
→ DECIDE
→ IMPLEMENT
```
