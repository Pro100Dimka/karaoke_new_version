# Python Backend — универсальные правила написания кода

**Python:** 3.12+
**Цель:** код должен быть максимально коротким, чистым, понятным и единообразным, но не становиться clever-code ради экономии строк.

Главный принцип:

```text
Короткий код хорош только тогда,
когда он читается легче длинного.
```

Если сокращение экономит 3 строки, но заставляет разбираться в выражении — использовать более явный вариант.

---

## Основные правила

1. Использовать **list comprehension**, если цикл только фильтрует/преобразует элементы и собирает список.

```python
items = [transform(item) for item in source if is_valid(item)]
```

2. Не использовать comprehension, если внутри нужны несколько действий, `try`, логирование или сложные условия.

3. Для множества использовать set comprehension:

```python
ids = {item.id for item in items}
```

4. Для словаря использовать dict comprehension:

```python
users = {user.id: user for user in users}
```

5. Не создавать comprehension длиннее одной логической строки, если его становится трудно читать.

6. Не использовать вложенные comprehensions, если приходится мысленно разбирать порядок циклов.

7. Generator expression использовать, если коллекция целиком не нужна:

```python
total = sum(item.price for item in items)
```

8. Не создавать список только ради передачи его в `sum`, `any`, `all`, `min`, `max`.

Плохо:

```python
any([item.active for item in items])
```

Хорошо:

```python
any(item.active for item in items)
```

9. Использовать `any()` вместо цикла с флагом.

```python
has_errors = any(item.error for item in items)
```

10. Использовать `all()` вместо цикла с флагом.

```python
all_ready = all(item.ready for item in items)
```

11. Помнить, что:

```python
any([]) is False
all([]) is True
```

и учитывать это явно.

12. Использовать `sum()` вместо ручного накопления числа.

13. Использовать `min()`/`max()` вместо ручного поиска минимального/максимального элемента.

14. Использовать `min(..., key=...)` и `max(..., key=...)` вместо предварительной сортировки.

Плохо:

```python
latest = sorted(items, key=lambda x: x.created_at)[-1]
```

Хорошо:

```python
latest = max(items, key=lambda item: item.created_at)
```

15. Не сортировать коллекцию, если нужен только один минимальный или максимальный элемент.

16. Использовать `sorted()` если нужен новый список.

17. Использовать `.sort()` если допустимо изменить существующий список.

18. Не писать:

```python
items = sorted(items)
```

если mutation допустима и список принадлежит текущей функции:

```python
items.sort()
```

19. Использовать `reverse=True`, а не сортировать и потом разворачивать.

20. Использовать `key=` вместо преобразования коллекции только ради сортировки.

---

## Условия

21. Использовать тернарное выражение для простого выбора одного значения:

```python
status = "adult" if age >= 18 else "minor"
```

22. Не использовать тернарник, если одна из ветвей сама содержит сложное выражение.

23. Не вкладывать тернарные выражения друг в друга.

Плохо:

```python
value = a if x else b if y else c
```

24. Использовать chained comparison:

```python
0 <= value <= 100
```

вместо:

```python
value >= 0 and value <= 100
```

25. Использовать:

```python
if value is None:
```

вместо:

```python
if value == None:
```

26. Использовать:

```python
if value is not None:
```

вместо:

```python
if value != None:
```

27. Для boolean не писать:

```python
if enabled == True:
```

Писать:

```python
if enabled:
```

28. Не писать:

```python
if enabled == False:
```

Писать:

```python
if not enabled:
```

29. Не использовать `not not value` для boolean conversion.

Использовать:

```python
bool(value)
```

30. Использовать truthiness для обычных коллекций:

```python
if items:
```

вместо:

```python
if len(items) > 0:
```

31. Использовать:

```python
if not items:
```

вместо:

```python
if len(items) == 0:
```

32. Но если `0`, `""`, `False` и `None` имеют разный смысл — проверять явно.

33. Использовать membership:

```python
if state in allowed_states:
```

вместо:

```python
if state == A or state == B or state == C:
```

34. Для постоянного набора использовать `frozenset`:

```python
ALLOWED_STATES = frozenset({State.READY, State.PAUSED})
```

35. Для маленького локального набора допустим tuple:

```python
if status in ("ready", "paused"):
```

36. Не создавать `set` внутри горячего вызываемого кода каждый раз без необходимости.

37. Использовать `not in` вместо:

```python
if not value in items:
```

38. Использовать guard clauses и ранние `return`.

39. Избегать глубоких `if`.

Плохо:

```python
if song:
    if song.ready:
        if user.allowed:
            play()
```

Хорошо:

```python
if song is None:
    return

if not song.ready:
    return

if not user.allowed:
    return

play()
```

40. Условие с наиболее быстрым/простым отказом ставить раньше.

41. Не создавать переменную `result` только ради возврата:

```python
result = calculate()
return result
```

Если имя ничего не добавляет:

```python
return calculate()
```

42. Но сохранять переменную, если имя объясняет смысл или нужно для debugging.

43. Не использовать `else` после безусловного `return`.

Плохо:

```python
if invalid:
    return None
else:
    return value
```

Хорошо:

```python
if invalid:
    return None

return value
```

44. То же правило после `raise`, `continue`, `break`.

45. Избегать отрицательных условий, если положительный вариант читается проще.

---

## Walrus operator

46. Использовать `:=`, если он устраняет реальное повторение выражения.

```python
if (match := pattern.search(text)):
    return match.group(1)
```

47. Не использовать `:=` только ради уменьшения количества строк.

48. Не использовать несколько `:=` в одном выражении.

49. Не использовать walrus с выражением, имеющим серьёзный side effect.

50. Если переменная используется дальше в нескольких местах — обычное присваивание часто понятнее.

---

## Словари

51. Использовать `.get()` для необязательного значения:

```python
avatar = profile.get("avatar", DEFAULT_AVATAR)
```

52. Не использовать `.get()` если нужно отличить отсутствующий ключ от значения `None`.

53. Для обязательного ключа использовать:

```python
value = payload["id"]
```

а не:

```python
value = payload.get("id")
```

чтобы ошибка не скрывалась.

54. Использовать `.setdefault()` только для действительно простых случаев.

55. Не использовать `.setdefault()` для сложной mutation-логики.

56. Для группировки часто использовать `defaultdict`.

```python
grouped: defaultdict[str, list[Song]] = defaultdict(list)

for song in songs:
    grouped[song.artist].append(song)
```

57. Для подсчётов использовать `Counter`.

```python
counts = Counter(item.status for item in items)
```

58. Не писать вручную:

```python
counts[key] = counts.get(key, 0) + 1
```

если подходит `Counter`.

59. Для объединения dict использовать `|`:

```python
merged = defaults | overrides
```

60. Для обновления существующего dict использовать `|=` или `.update()`.

61. Не использовать `{**a, **b}` в новом коде, если `a | b` читается лучше.

62. Использовать unpacking для небольшого явного расширения словаря:

```python
payload = {**base, "status": status}
```

если это действительно читабельнее.

63. Не мутировать входной dict, если функция не обязана это делать.

64. Для mapping, который не должен изменяться, использовать `Mapping` в type hint вместо `dict`.

65. Не использовать dict как замену нормальному domain object, если структура стабильна.

---

## Списки и последовательности

66. Использовать unpacking:

```python
combined = [*left, *right]
```

если это читается лучше.

67. Для большого количества последовательностей чаще использовать `itertools.chain`.

68. Использовать multiple assignment:

```python
x, y = y, x
```

69. Использовать unpacking:

```python
first, *middle, last = values
```

только если структура действительно известна.

70. Не использовать индексирование:

```python
first = values[0]
second = values[1]
```

если естественнее unpack:

```python
first, second = values
```

71. Использовать `enumerate()` вместо ручного счётчика.

Плохо:

```python
index = 0
for item in items:
    ...
    index += 1
```

Хорошо:

```python
for index, item in enumerate(items):
```

72. Использовать `enumerate(items, start=1)`, если нумерация должна начинаться с 1.

73. Использовать `zip()` для параллельного обхода.

74. Не использовать `range(len(items))`, если индекс не нужен.

75. Если нужен и индекс, и элемент — `enumerate()`.

76. Если нужно сравнивать соседние элементы, использовать `itertools.pairwise()`.

```python
for previous, current in pairwise(items):
```

77. Для chunking использовать `itertools.batched()` в Python 3.12.

```python
for batch in batched(items, 100):
```

78. Не писать собственный `chunks()` без причины.

79. Для flatten одного уровня использовать подходящий comprehension или `chain.from_iterable`.

80. Не использовать `sum(lists, [])` для объединения списков.

81. Использовать slice copy:

```python
copy = items[:]
```

только если это реально понятнее `items.copy()`.

82. Обычно предпочитать:

```python
items.copy()
```

потому что намерение очевиднее.

83. Не копировать коллекцию без необходимости.

84. Использовать negative indexing:

```python
items[-1]
```

вместо:

```python
items[len(items) - 1]
```

85. Использовать slicing:

```python
items[:limit]
```

вместо ручного цикла.

86. Для удаления последнего элемента использовать `.pop()`.

87. Для queue не использовать `list.pop(0)`.

Использовать:

```python
deque
```

88. Для stack обычный list подходит:

```python
append()
pop()
```

89. Для membership больших наборов использовать `set`, а не list.

90. Если важен порядок и membership — выбирать структуру осознанно, а не автоматически.

---

## Строки

91. Использовать f-string.

```python
message = f"Song {song_id} failed"
```

92. Не использовать `%` formatting в новом коде.

93. `.format()` использовать только если он реально нужен.

94. Не конкатенировать много строк через `+`.

95. Для большого количества частей использовать:

```python
"".join(parts)
```

96. Для строк через разделитель:

```python
", ".join(names)
```

97. Не использовать `str(value)` внутри f-string:

Плохо:

```python
f"{str(value)}"
```

Хорошо:

```python
f"{value}"
```

98. Для debug representation использовать:

```python
f"{value!r}"
```

99. Для округления:

```python
f"{value:.2f}"
```

100. Использовать `.strip()` вместо ручного удаления пробелов.

101. Для проверки prefix использовать `.startswith()`.

102. Для suffix использовать `.endswith()`.

103. Не писать:

```python
text[:4] == "http"
```

если можно:

```python
text.startswith("http")
```

104. Для замены ограниченного количества частей использовать `.replace()`.

105. Regex использовать только если задача действительно regex-задача.

106. Не использовать regex вместо `.split()`, `.startswith()`, `.replace()` без необходимости.

107. Для нескольких допустимых prefix:

```python
text.startswith(("http://", "https://"))
```

108. Для case-insensitive пользовательского текста использовать `.casefold()`, когда нужна Unicode-корректность.

109. `.lower()` достаточен только если требования проще.

110. Не вызывать `.strip().lower()` повторно в одном выражении — нормализовать один раз.

---

## Числа

111. Использовать `math.isclose()` для floating-point comparison, если нужна приблизительная равность.

112. Не писать:

```python
a == b
```

для вычисленных float, если точное битовое равенство не является целью.

113. Использовать `round()` только для представления/явной бизнес-логики, не как способ лечить ошибки float.

114. Для денег использовать `Decimal`, если точность денег действительно нужна.

115. Не использовать float для финансовых расчётов.

116. Использовать `_` в больших числах:

```python
MAX_SIZE = 100_000_000
```

117. Использовать `math.inf`, а не магическое огромное число.

118. Для ограничения значения использовать:

```python
value = min(max(value, minimum), maximum)
```

если такой clamp действительно ясен.

119. Если clamp используется часто — создать маленькую `clamp()` функцию.

120. Не создавать сложную математическую helper-функцию, если встроенная функция уже существует.

---

## Функции

121. Функция должна делать одну вещь.

122. Имя функции должно быть глаголом или ясно описывать вычисление:

```python
validate_project()
build_manifest()
find_song()
```

123. Не использовать имена:

```python
process()
handle()
do()
run()
```

без контекста.

124. Если функция возвращает boolean, использовать `is_`, `has_`, `can_`, `should_`.

125. Не принимать больше аргументов, чем можно нормально понять.

126. Если параметров много и они относятся к одной концепции — создать typed options object.

127. Использовать keyword-only arguments для неоднозначных параметров:

```python
def process_song(song_id: str, *, force: bool = False) -> None:
```

128. Не делать boolean positional arguments.

Плохо:

```python
process(song, True, False)
```

129. Не использовать mutable default argument.

Плохо:

```python
def add(item, items=[]):
```

130. Использовать:

```python
def add(item, items=None):
    items = [] if items is None else items
```

131. Ещё лучше — пересмотреть, должна ли функция вообще принимать mutable optional container.

132. Не изменять аргументы неожиданно.

133. Если функция мутирует объект — это должно быть понятно из имени/contract.

134. Предпочитать возвращать новое значение для небольших value objects.

135. Не возвращать разные несвязанные типы без явного union.

136. Не возвращать `None` как скрытую ошибку там, где отсутствие является исключительным состоянием.

137. Если отсутствие ожидаемо — `T | None` нормально.

138. Если ошибка бизнесовая — domain exception/result.

139. Не использовать tuple из 6 значений без имен.

Плохо:

```python
return id_, title, artist, status, duration, path
```

140. Использовать dataclass/NamedTuple/DTO.

141. Не создавать функцию только ради обёртки другой функции без дополнительного смысла.

142. Удалять passthrough wrappers после завершения миграции.

143. Не создавать `*_helper()` если можно дать точное имя.

144. Не писать функции с параметром `mode`, который полностью меняет её смысл, если это фактически две разные операции.

145. Если две операции имеют разный lifecycle/errors — разделять их.

---

## Lambda

146. Использовать `lambda` для маленького `key=`:

```python
songs.sort(key=lambda song: song.title)
```

147. Если есть готовый attribute access, предпочитать `operator.attrgetter` только когда это реально делает код понятнее.

148. Не использовать multi-expression lambda.

149. Если lambda требует комментария — сделать обычную функцию.

150. Не присваивать сложную lambda переменной вместо `def`.

---

## Itertools

151. Перед написанием сложного цикла проверить `itertools`.

152. Использовать `pairwise()` для соседних элементов.

153. Использовать `batched()` для batch.

154. Использовать `chain()`/`chain.from_iterable()` для потокового объединения.

155. Использовать `islice()` вместо материализации большого списка ради slice.

156. Использовать `takewhile()`/`dropwhile()` только если они читаются понятнее обычного цикла.

157. Не использовать itertools ради «питоничности», если обычный цикл очевиднее.

---

## Встроенные функции

158. Перед написанием helper проверить стандартную библиотеку Python.

159. Использовать `next(iterator, default)` вместо цикла для поиска первого совпадения:

```python
song = next((song for song in songs if song.id == song_id), None)
```

160. Не использовать `next(...)` с гигантским сложным generator expression.

161. Использовать `reversed()` вместо ручного reverse-loop.

162. Использовать `range(start, stop, step)` вместо ручного increment.

163. Использовать `abs()`.

164. Использовать `divmod()` если одновременно нужны quotient и remainder.

165. Использовать `pow()` только когда он лучше оператора `**` или нужен modulus.

166. Использовать `map()` только если он реально читается лучше comprehension.

Обычно:

```python
names = [user.name for user in users]
```

понятнее:

```python
names = list(map(attrgetter("name"), users))
```

167. Использовать `filter()` редко; comprehension обычно понятнее.

168. Не использовать `reduce()` для задач, которые нормально решаются `sum`, `min`, `max`, `any`, `all`, `join`.

169. `functools.reduce()` использовать только для настоящего reduction, который остаётся понятным.

---

## Типизация

170. Все public functions должны иметь type hints.

171. Для нового Python использовать:

```python
list[str]
dict[str, int]
str | None
```

вместо старых:

```python
List[str]
Dict[str, int]
Optional[str]
```

172. Использовать `Sequence[T]`, если функция только читает последовательность.

173. Использовать `Iterable[T]`, если нужен только однократный обход.

174. Использовать `Collection[T]`, если нужны `len` и membership.

175. Использовать `Mapping[K, V]`, если dict не мутируется.

176. Не принимать `list`, если реально подойдет любой iterable.

177. Но не делать signature максимально абстрактным без пользы.

178. Возвращать конкретный тип, если caller должен знать структуру.

179. Не использовать `Any` ради удобства.

180. `Any` на внешнем boundary нужно быстро валидировать/преобразовывать.

181. Использовать `TypeAlias` для сложных повторяющихся типов.

182. Использовать `Literal` только для действительно маленьких закрытых наборов, если enum не нужен.

183. Для domain state чаще предпочитать `Enum`.

184. Использовать `Protocol`, если нужен structural interface.

185. Не создавать Protocol для каждого класса.

186. `cast()` использовать редко и с понятной причиной.

187. Не использовать `# type: ignore` без комментария/причины.

188. Не скрывать плохой design с помощью `Any`.

---

## Dataclass и модели

189. Использовать `@dataclass` для простых структур данных.

190. Использовать `frozen=True`, если объект по смыслу immutable.

191. Использовать `slots=True`, если таких объектов много и dynamic attrs не нужны.

```python
@dataclass(frozen=True, slots=True)
class SongIdentity:
    value: str
```

192. Не превращать каждый объект в dataclass автоматически.

193. Не использовать dataclass, если объект имеет сложный lifecycle/behavior и обычный class яснее.

194. Использовать `field(default_factory=list)` вместо mutable default.

195. Не создавать `__init__` вручную, если dataclass полностью решает задачу.

196. Не переопределять generated dataclass methods без необходимости.

197. Для API schemas использовать Pydantic.

198. Не использовать Pydantic как universal внутреннюю model layer.

---

## Enum

199. Использовать `StrEnum` для строковых API/state enum в Python 3.11+:

```python
class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
```

200. Не повторять строковые literals состояния по проекту.

201. Для mapping enum → label использовать словарь, если поведения нет.

202. Если у state есть поведение, допустим method/property enum.

203. Не превращать Enum в огромный business service.

---

## Match

204. Использовать `match` для ясного structural/state branching.

205. Не использовать `match` вместо простого dict lookup.

206. Не использовать `match` для двух простых boolean branches.

207. `match` хорош, если branches различаются поведением, а не только значениями.

208. Всегда учитывать unexpected/default branch там, где вход не полностью контролируется.

---

## Исключения

209. Ловить максимально конкретное exception.

210. Не использовать:

```python
except:
```

211. `except Exception` допустим только на настоящей верхней boundary для логирования/изоляции.

212. Никогда не делать:

```python
except Exception:
    pass
```

213. При повторном выбрасывании своей ошибки использовать chaining:

```python
raise StorageError(path) from exc
```

214. Использовать:

```python
raise NewError() from None
```

только если исходная ошибка действительно не нужна пользователю/логике.

215. Не использовать exception для обычного boolean condition.

216. Сообщение exception должно содержать полезный контекст.

217. Не включать в ошибки secrets.

218. Не ловить исключение, только чтобы вернуть `False`, если потеряется важная причина ошибки.

219. Domain exceptions должны быть маленькими и конкретными.

220. Не создавать сотни exception-классов без необходимости; группировать по смыслу.

---

## Context managers

221. Использовать `with` для файлов, locks, DB/transaction resources.

222. Не вызывать `.close()` вручную, если объект поддерживает context manager.

223. Для собственного resource lifecycle использовать `contextmanager` только если он упрощает код.

224. Не превращать сложный workflow в context manager ради красоты.

225. Использовать `ExitStack`, если количество ресурсов динамическое.

---

## Файлы и Path

226. Использовать `pathlib.Path`, а не ручную конкатенацию путей строками.

227. Не писать:

```python
folder + "/" + filename
```

228. Использовать:

```python
folder / filename
```

229. Использовать `.exists()`, `.is_file()`, `.is_dir()`.

230. Использовать `.read_text()`/`.write_text()` для маленьких текстовых файлов.

231. Для больших файлов использовать streaming `open()`.

232. Всегда указывать encoding для текстовых файлов:

```python
encoding="utf-8"
```

233. Не использовать `os.path` в новом коде без конкретной причины.

234. Не преобразовывать `Path` в `str` раньше, чем требует внешний API.

235. Не делать repeated `.resolve()` без необходимости.

236. Не использовать filename как идентификатор entity.

---

## JSON

237. JSON serialization/deserialization должна быть централизована.

238. Не делать `json.loads()` в десятках domain modules.

239. External JSON валидировать сразу после чтения.

240. Не работать с raw dict глубоко в application.

241. Для canonical JSON использовать стабильные правила serialization.

242. Не записывать JSON напрямую поверх существующего canonical файла без atomic replacement.

---

## Логирование

243. Использовать стандартный `logging`, не `print()` в production.

244. Использовать parameterized logging:

```python
logger.info("Processing song %s", song_id)
```

вместо:

```python
logger.info(f"Processing song {song_id}")
```

если форматирование может быть ненужным при выключенном уровне.

245. Не логировать одно событие на каждом слое.

246. Ошибка должна логироваться один раз на boundary, которая реально её обрабатывает.

247. Не писать stack trace для ожидаемой domain ошибки без необходимости.

248. Для unexpected exception использовать `logger.exception()`.

249. Не логировать большие payload.

250. Не логировать tokens/passwords/secrets.

---

## Async

251. Использовать async только для настоящего I/O concurrency.

252. Не делать CPU-heavy работу непосредственно внутри `async def`.

253. Не вызывать blocking library внутри event loop без выноса.

254. Не использовать `asyncio.create_task()` без owner.

255. Все created tasks должны иметь lifecycle/error handling.

256. Использовать `asyncio.TaskGroup` в Python 3.11+ для structured concurrency.

```python
async with asyncio.TaskGroup() as group:
    group.create_task(load_a())
    group.create_task(load_b())
```

257. Предпочитать `TaskGroup` ручному набору orphan tasks.

258. Не использовать concurrency, если sequential код достаточно быстрый.

259. Не запускать сотни tasks без semaphore/limit.

260. Таймауты задавать явно.

261. Для async timeout в Python 3.11+ использовать:

```python
async with asyncio.timeout(seconds):
```

где подходит.

262. Не смешивать sync locks и async locks без понимания boundary.

---

## Dates и time

263. Persistent timestamps хранить timezone-aware.

264. Использовать UTC для persistence.

265. Не использовать naive datetime для persistent application state.

266. Использовать:

```python
datetime.now(UTC)
```

вместо:

```python
datetime.utcnow()
```

267. Для измерения duration использовать:

```python
time.monotonic()
```

или:

```python
time.perf_counter()
```

а не wall-clock datetime.

268. Не сравнивать durations через system clock.

---

## `None`

269. `None` должен иметь конкретный смысл.

270. Не использовать `None` как универсальное:

```text
not found
invalid
failed
not loaded
disabled
```

одновременно.

271. Если состояний несколько — использовать Enum/result object.

272. Не использовать `Optional` просто потому, что не хочется инициализировать значение.

---

## Sentinel

273. Если нужно отличить:

```text
argument omitted
```

от:

```text
argument explicitly None
```

использовать sentinel.

```python
_MISSING = object()
```

274. Не использовать магическую строку `"__missing__"` как sentinel.

---

## Properties

275. Использовать `@property` для дешёвого логического значения.

276. Не скрывать тяжёлый I/O за property.

Плохо:

```python
@property
def project(self):
    return load_from_database()
```

277. Property не должна иметь неожиданные side effects.

---

## Классы

278. Не создавать class, если достаточно функции.

279. Class оправдан, если есть:

```text
state
lifecycle
related behavior
dependency ownership
```

280. Не создавать `Manager` просто для namespace функций.

281. Использовать module как namespace, если state не нужен.

282. Конструктор не должен выполнять тяжёлую работу.

283. Конструктор только устанавливает valid state/dependencies.

284. Heavy operation делать через:

```python
load()
start()
initialize()
```

если она действительно нужна.

285. Не создавать static methods вместо обычных module-level functions без причины.

286. `@classmethod` использовать для alternative constructors.

287. Не создавать abstract base class с одним implementation без причины.

---

## Imports

288. Imports всегда в начале файла, кроме действительно специальных runtime cases.

289. Не использовать local import для сокрытия circular dependency.

290. Не использовать wildcard import:

```python
from module import *
```

291. Импортировать только нужное.

292. Не делать:

```python
import module
```

если постоянно нужен один конкретный тип и direct import делает код яснее.

293. Но не импортировать десятки отдельных symbols, если namespace module улучшает понимание.

294. Не создавать циклы imports.

295. `TYPE_CHECKING` использовать, если он реально решает type-only dependency, а не архитектурный cycle.

---

## Constants

296. Constants писать в `UPPER_SNAKE_CASE`.

297. Не создавать constant для каждого literal.

298. Выносить в constant значения, которые являются policy/domain rule.

299. Константа должна жить рядом с областью, которой принадлежит.

300. Не создавать giant `constants.py` на весь backend.

---

## Магические флаги

301. Не использовать числа/строки для переключения режима:

```python
mode = 2
```

Использовать enum.

302. Не использовать `**kwargs` для скрытого набора флагов бизнес-логики.

303. `**kwargs` допустим на адаптерных/обёрточных boundaries, если действительно оправдан.

---

## Распаковка

304. Использовать `*args` только когда API действительно variadic.

305. Не использовать `*args` вместо нормальной signature.

306. Использовать `**kwargs` осознанно, не чтобы скрыть параметры.

307. При создании нового объекта из существующих полей unpacking допустим:

```python
payload = {**base, "status": status}
```

308. Но typed object обычно лучше endless dict unpacking.

---

## Data mapping

309. Если набор if/elif только сопоставляет ключ со значением — использовать mapping.

310. Если mapping immutable — объявлять один раз, не внутри функции.

311. Для factory mapping:

```python
FACTORIES = {
    Type.A: build_a,
    Type.B: build_b,
}
```

вместо длинного `if/elif`, если behavior простой.

312. Проверять неизвестный ключ явно.

---

## Циклы

313. Не менять коллекцию, по которой прямо сейчас итерируешься, если это может изменить структуру iteration.

314. Если нужно удалить элементы — фильтровать или итерироваться по копии.

315. Не использовать index-loop, если можно direct iteration.

316. Использовать `_` для намеренно неиспользуемого значения:

```python
for _ in range(retries):
```

317. Не использовать `_` для значения, которое потом вдруг используется.

318. `break` и `continue` использовать, если они упрощают flow.

319. Не бояться `continue`, если он убирает вложенность.

320. Использовать `for ... else` только если команда понимает этот Python idiom и код реально становится яснее.

---

## Поиск элемента

321. Для первого элемента использовать `next()`.

322. Для наличия использовать `any()`.

323. Для всех — `all()`.

324. Для index использовать `enumerate()` или `.index()` только если это действительно нужно.

325. Не проходить одну коллекцию несколько раз без необходимости, особенно если она большая.

---

## Множества

326. Для уникальности использовать `set`.

327. Для разности использовать:

```python
left - right
```

328. Для пересечения:

```python
left & right
```

329. Для объединения:

```python
left | right
```

330. Для subset:

```python
left <= right
```

331. Не писать циклы для операций множеств, если операции `set` выражают смысл напрямую.

---

## Сравнение коллекций

332. Сравнивать sequence напрямую, если важен порядок.

333. Использовать `set`, если порядок/дубликаты не важны.

334. Использовать `Counter`, если важны дубликаты, но не порядок.

335. Не сортировать обе коллекции только ради сравнения, если лучше подходит Counter/set.

---

## Сложные выражения

336. Не писать цепочку из 6 вызовов в одну строку только ради краткости.

337. Разбивать выражение, если промежуточное имя объясняет смысл.

338. Не использовать more than one non-trivial comprehension per expression.

339. Не писать:

```python
return foo(bar(x)) if baz(qux(y)) else spam(eggs(z))
```

если это трудно читать.

340. Максимальная краткость не является целью.

---

## Повторные вычисления

341. Не вызывать одну дорогую функцию несколько раз.

Плохо:

```python
if calculate(song):
    save(calculate(song))
```

Хорошо:

```python
result = calculate(song)

if result:
    save(result)
```

342. Walrus допустим для маленьких случаев.

343. Не cache-ить дешёвое вычисление без причины.

---

## Side effects

344. Не смешивать вычисление и mutation без необходимости.

345. Чистая функция предпочтительна, если состояние не требуется.

346. Если функция меняет несколько независимых ресурсов — transaction/orchestrator должен быть явным.

347. Не помещать side effects в comprehension.

Плохо:

```python
[save(item) for item in items]
```

Хорошо:

```python
for item in items:
    save(item)
```

348. Не использовать `map()` для side effects.

---

## Возвращаемые значения

349. Возвращать объект, который caller действительно использует.

350. Не возвращать весь internal object ради одного поля.

351. Не возвращать `True` всегда.

352. Command без meaningful result может возвращать `None`.

353. Create operation обычно возвращает созданный entity/result.

354. Update operation возвращает обновлённый result, если это полезно caller.

---

## Ранний выход

355. Проверки ошибок располагать в начале.

356. Happy path должен читаться сверху вниз.

357. Не держать happy path внутри большого `if`.

358. Не использовать один `try` на 100 строк.

359. Try block должен быть минимальным — только код, который реально может выбросить ожидаемую ошибку.

---

## Проверки

360. Не писать одну и ту же validation в 5 местах.

361. Общий domain invariant имеет одну canonical implementation.

362. Boundary validation и domain invariant — разные вещи.

363. Boundary проверяет тип/формат.

364. Domain проверяет бизнес-смысл.

365. Не использовать `assert` для user input.

366. `assert` допустим для programmer invariants.

---

## Публичный API

367. Публичная функция должна иметь понятную signature.

368. Не экспортировать внутренние helpers.

369. Не re-export everything через `__init__.py`.

370. Не делать public API больше, чем необходимо.

371. Если caller начинает использовать `_internal_function`, исправить boundary, а не убрать underscore.

---

## Legacy и refactor

372. При замене реализации удалить старую.

373. Не оставлять:

```text
old
new
legacy
v2
final
```

без реальной compatibility-причины.

374. Все call sites должны перейти на canonical path.

375. После refactor делать repository search старого имени.

376. Удалять старые imports.

377. Удалять старые tests.

378. Удалять старые adapters.

379. Удалять obsolete configuration.

380. Удалять obsolete dependencies.

381. Не оставлять compatibility wrapper без срока удаления.

382. Deprecated API имеет removal condition.

383. Git является backup старой реализации.

---

## Комментарии

384. Комментарий объясняет **почему**, а не **что**.

385. Если приходится объяснять сложный код большим комментарием — попробовать сначала упростить код.

386. Не оставлять закомментированный код.

387. TODO должен быть конкретным.

388. FIXME использовать только для реального известного дефекта.

389. Не использовать комментарии как замену типам и хорошим именам.

---

## Naming

390. Переменная должна называться по смыслу.

391. Использовать:

```python
song
recording
revision
```

а не:

```python
data
obj
item
thing
```

если конкретный тип известен.

392. Короткие имена допустимы для очень локального математического/итерационного контекста.

393. Не использовать `l`, `O`, `I` как одиночные имена из-за визуальной неоднозначности.

394. Collections во множественном числе:

```python
songs
jobs
recordings
```

395. Dict mapping называть по смыслу:

```python
song_by_id
```

а не просто:

```python
mapping
```

396. Set может называться:

```python
active_ids
supported_formats
```

397. Не добавлять тип в имя без необходимости:

```python
song_list
```

часто хуже:

```python
songs
```

398. `*_manager` использовать только если действительно управляется lifecycle/resources.

399. `*_service` использовать только когда имя domain responsibility нельзя сделать точнее.

400. Предпочитать точные названия:

```text
ProjectPublisher
ModelDownloader
PackageImporter
RecordingRegistry
```

---

## Форматирование

401. Один formatter для всего backend.

402. Не форматировать руками против formatter.

403. Не пытаться помещать всю функцию в одну строку.

404. Не писать несколько statements через `;`.

405. Не писать:

```python
if condition: return value
```

в production code, кроме очень редких очевидных случаев.

406. Сохранять визуальные блоки логики.

407. Пустые строки использовать для разделения смысловых частей, а не после каждой строки.

408. Не выравнивать вручную `=` пробелами.

---

## Итоговый стиль

409. Сначала проверить встроенную функцию Python.

410. Затем стандартную библиотеку.

411. Затем простой цикл/условие.

412. Только потом создавать helper/abstraction.

413. Предпочитать одно понятное выражение трём boilerplate строкам.

414. Но предпочитать три понятные строки одному загадочному выражению.

415. Если код нужно перечитать два раза, чтобы понять — скорее всего он слишком умный.

416. Если одинаковый pattern встречается постоянно — стандартизировать его.

417. Если pattern используется один раз — не создавать framework.

418. Если новый код делает старый ненужным — удалить старый сразу.

419. Если значение может быть выражено данными — предпочитать данные повторяющимся веткам.

420. Если behavior различается — не прятать его искусственно в mapping.

421. Если функция только фильтрует — comprehension/filtering.

422. Если функция только ищет один элемент — `next()`.

423. Если только проверяет наличие — `any()`.

424. Если проверяет всех — `all()`.

425. Если считает — `sum()`/`Counter`.

426. Если группирует — `defaultdict`.

427. Если ищет уникальность — `set`.

428. Если обрабатывает пары соседей — `pairwise()`.

429. Если делает batches — `batched()`.

430. Если работает с файлами — `Path`.

431. Если создаёт временный resource — context manager.

432. Если имеет закрытый state — Enum.

433. Если структура данных стабильна — typed object/dataclass, а не бесконечный dict.

434. Если параметров много — options object.

435. Если операция большая — маленький orchestrator + отдельные операции.

436. Если side effect не очевиден из имени — переименовать функцию.

437. Если exception ожидаем — сделать его domain-specific.

438. Если fallback происходит — он должен быть explicit.

439. Если код повторяется семантически — извлечь общий primitive.

440. Если код только выглядит похоже — не создавать abstraction автоматически.

---

# Финальный принцип

Всегда выбирать в таком порядке:

```text
1. Самый понятный вариант.
2. Самый простой вариант.
3. Самый короткий вариант.
```

Не наоборот.

Эталонный Python-код должен выглядеть так, будто для задачи **не существует более простого способа написать то же самое без потери ясности**.

```text
BE PYTHONIC
≠
WRITE THE FEWEST LINES

BE PYTHONIC
=
USE THE LANGUAGE TO EXPRESS INTENT DIRECTLY
```

**Статус:** `PYTHON CODE STYLE RULES — LOCKED`
