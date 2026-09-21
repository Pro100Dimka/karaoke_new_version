# TypeScript Frontend — универсальные правила написания кода

**Stack**

```text
TypeScript
React
Electron
Theme UI kit (src/theme/ui)
Formik
```

**Цель**

```text
коротко
красиво
типобезопасно
читаемо
предсказуемо
без дублирования
без clever-code
```

Главное правило:

```text
КОД ДОЛЖЕН БЫТЬ КОРОЧЕ,
ТОЛЬКО ЕСЛИ ОН СТАНОВИТСЯ ПОНЯТНЕЕ.
```

---

# 1. Nullish Coalescing

Использовать:

```ts
const value = input ?? fallback;
```

вместо:

```ts
const value = input !== null && input !== undefined ? input : fallback;
```

---

# 2. Не путать `??` и `||`

`??` использовать, если допустимы:

```text
0
false
""
```

`||` — только если все falsy действительно считаются отсутствием.

---

# 3. Optional Chaining

Использовать:

```ts
user?.address?.street
```

вместо:

```ts
user && user.address && user.address.street
```

---

# 4. Optional method call

Использовать:

```ts
callback?.();
```

вместо:

```ts
if (callback) {
  callback();
}
```

для простого вызова.

---

# 5. Optional array access

Допустимо:

```ts
items?.[0]
```

если сама коллекция optional.

---

# 6. Nullish assignment

Использовать:

```ts
value ??= fallback;
```

если присваивать нужно только для `null | undefined`.

---

# 7. Logical OR assignment

Использовать:

```ts
name ||= "Anonymous";
```

только если:

```text
""
0
false
```

действительно считаются отсутствующим значением.

---

# 8. Logical AND assignment

Использовать:

```ts
enabled &&= canUseFeature;
```

только когда это очевидно читается.

Не использовать ради трюка.

---

# 9. Boolean conversion

Предпочитать:

```ts
Boolean(value)
```

если важна ясность.

---

# 10. `!!value`

Допустимо в очень локальном очевидном контексте:

```ts
const hasItems = !!items.length;
```

Но не делать `!!` обязательным стилем.

---

# 11. Number conversion

Предпочитать:

```ts
Number(value)
```

в production-коде.

---

# 12. Унарный `+`

Допустим только в короткой очевидной математической логике.

Не использовать:

```ts
const age = +input;
```

если `Number(input)` читается лучше.

---

# 13. String conversion

Использовать:

```ts
String(value)
```

если нужна явная конверсия.

---

# 14. Не использовать template literal только ради преобразования

Плохо:

```ts
const id = `${value}`;
```

если смысл:

```ts
String(value)
```

---

# 15. Тернарный оператор

Использовать для простого выбора значения:

```ts
const status = active ? "active" : "inactive";
```

---

# 16. Не использовать вложенные тернарники

Плохо:

```ts
const value = a ? x : b ? y : z;
```

---

# 17. Если тернарник плохо читается — обычный `if`

---

# 18. Guard clauses

Использовать ранний `return`.

Плохо:

```ts
if (song) {
  if (song.ready) {
    openSong(song);
  }
}
```

Хорошо:

```ts
if (!song || !song.ready) return;

openSong(song);
```

---

# 19. Не использовать `else` после `return`

Плохо:

```ts
if (!ready) {
  return;
} else {
  start();
}
```

Хорошо:

```ts
if (!ready) return;

start();
```

---

# 20. То же после `throw`

---

# 21. То же после `continue`

---

# 22. То же после `break`

---

# 23. Membership через `includes`

Использовать:

```ts
allowedStates.includes(state)
```

вместо:

```ts
state === A || state === B || state === C
```

для маленьких списков.

---

# 24. Для частых membership checks использовать `Set`

```ts
const allowedStates = new Set([A, B, C]);

if (allowedStates.has(state)) {
  ...
}
```

---

# 25. `Set` особенно использовать для больших наборов

---

# 26. Не создавать новый `Set` внутри render/cycle без необходимости

---

# 27. Mapping вместо длинного `if`

Если различаются только значения:

```ts
const labels = {
  ready: "Ready",
  failed: "Failed"
};
```

---

# 28. Mapping вместо `switch`, если `switch` только возвращает данные

---

# 29. `switch` использовать, если ветки содержат разное поведение

---

# 30. Не использовать `switch` на 30 значений ради label mapping

---

# 31. Exhaustive switch

Для union/enum использовать exhaustive checking.

```ts
const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${value}`);
};
```

---

# 32. Не оставлять silent `default`, если все состояния известны

---

# 33. Object shorthand

Использовать:

```ts
const payload = { id, name };
```

вместо:

```ts
const payload = { id: id, name: name };
```

---

# 34. Method shorthand

Использовать:

```ts
const object = {
  run() {
    ...
  }
};
```

вместо:

```ts
run: function () {}
```

---

# 35. Property shorthand в destructuring

Использовать:

```ts
const { id, title } = song;
```

если это улучшает читаемость.

---

# 36. Не destructure всё подряд

Если:

```ts
song.title
song.artist
```

понятнее, не делать огромный destructuring.

---

# 37. Destructuring parameters осторожно

Хорошо:

```ts
const SongTitle = ({ title }: Props) => ...
```

Плохо:

```ts
const fn = ({
  a,
  b,
  c,
  d,
  e,
  f,
  g,
  h
}) => ...
```

---

# 38. Rest properties

Использовать:

```ts
const { id, ...rest } = item;
```

если это реально отражает intent.

---

# 39. Spread arrays

Использовать:

```ts
const all = [...left, ...right];
```

---

# 40. Для больших/частых объединений учитывать allocations

---

# 41. Spread objects

Использовать:

```ts
const next = { ...current, status: "ready" };
```

для простого immutable update.

---

# 42. Не использовать spread глубоко для сложных nested updates

Если:

```ts
{
  ...state,
  a: {
    ...state.a,
    b: {
      ...state.a.b
    }
  }
}
```

становится огромным — пересмотреть state shape.

---

# 43. `Object.assign` обычно не нужен для простого merge

---

# 44. `Object.keys`

Использовать только если действительно нужны keys.

---

# 45. `Object.values`

Использовать вместо:

```ts
Object.keys(obj).map(key => obj[key])
```

---

# 46. `Object.entries`

Использовать если нужны key + value.

---

# 47. `Object.fromEntries`

Использовать для построения object из entries.

```ts
const result = Object.fromEntries(entries);
```

---

# 48. Не писать manual reducer для `Object.fromEntries`, если он решает задачу прямо

---

# 49. Array `.map`

Использовать для преобразования.

---

# 50. `.map` не использовать для side effects

Плохо:

```ts
items.map(saveItem);
```

если результат игнорируется.

Хорошо:

```ts
for (const item of items) {
  saveItem(item);
}
```

---

# 51. `.filter`

Использовать для фильтрации.

---

# 52. `.find`

Использовать для поиска первого элемента.

---

# 53. `.findIndex`

Использовать только если нужен индекс.

---

# 54. `.some`

Использовать для `any`.

```ts
const hasError = items.some(item => item.error);
```

---

# 55. `.every`

Использовать для `all`.

```ts
const allReady = items.every(item => item.ready);
```

---

# 56. `.reduce` использовать осторожно

---

# 57. Не использовать `.reduce` для простого `map`, `filter`, `sum`, `group`

---

# 58. Простота важнее «функциональности»

Плохо:

```ts
items.reduce((acc, item) => [...acc, transform(item)], []);
```

Хорошо:

```ts
items.map(transform);
```

---

# 59. Сумма

```ts
const total = items.reduce((sum, item) => sum + item.value, 0);
```

нормальна.

---

# 60. Если reduce становится трудно читать — обычный цикл

---

# 61. `for...of`

Предпочитать для:

```text
side effects
async loops
complex flow
break/continue
```

---

# 62. Не использовать `.forEach` если нужен `await`

---

# 63. Не писать:

```ts
items.forEach(async item => {
  await save(item);
});
```

---

# 64. Для последовательного async:

```ts
for (const item of items) {
  await save(item);
}
```

---

# 65. Для параллельного async:

```ts
await Promise.all(items.map(save));
```

---

# 66. Не использовать `Promise.all` для unbounded тысячи тяжелых операций

---

# 67. Для ограниченной concurrency использовать limiter

---

# 68. `Promise.allSettled`

Использовать, если ошибки отдельных задач не должны остановить остальные.

---

# 69. Не использовать `Promise.allSettled` если failure должен fail-fast

---

# 70. Async function всегда возвращает `Promise`

Не писать лишний:

```ts
return Promise.resolve(value);
```

---

# 71. Не использовать `new Promise`, если существующий API уже Promise-based

---

# 72. `new Promise` только при адаптации callback API

---

# 73. `await` вместо длинных `.then()`

Предпочитать:

```ts
const data = await load();
```

---

# 74. `.then()` допустим для коротких цепочек, если читается лучше

---

# 75. Не смешивать `await` и `.then()` хаотично

---

# 76. Async errors ловить там, где можно обработать

---

# 77. Не оборачивать каждую async функцию в `try/catch`

---

# 78. Если catch только `throw error`, убрать его

---

# 79. Catch unknown

В TypeScript считать:

```ts
catch (error)
```

как `unknown`.

---

# 80. Не предполагать:

```ts
error.message
```

без проверки.

---

# 81. Использовать type guard для Error

```ts
const isError = (value: unknown): value is Error =>
  value instanceof Error;
```

---

# 82. Не использовать `catch (error: any)`

---

# 83. Не использовать `throw "message"`

Всегда:

```ts
throw new Error("message");
```

или domain error.

---

# 84. Error code отдельно от message

---

# 85. Не парсить текст Error для логики

---

# 86. `const` по умолчанию

---

# 87. `let` только если значение реально меняется

---

# 88. `var` запрещён

---

# 89. Не переиспользовать одну переменную для разных смыслов

Плохо:

```ts
let value = song;
value = value.title;
value = value.trim();
```

---

# 90. Variable scope минимален

---

# 91. Объявлять ближе к использованию

---

# 92. Не объявлять десятки переменных в начале функции

---

# 93. Не использовать generic `data`

Если это Song:

```ts
song
```

---

# 94. Не использовать `item` если можно назвать точнее

---

# 95. Но в коротком `.map` `item` допустим, если тип очевиден

---

# 96. Коллекции во множественном числе

```ts
songs
participants
recordings
```

---

# 97. Mapping называть по смыслу

```ts
songById
```

---

# 98. Set называть по смыслу

```ts
selectedIds
```

---

# 99. Boolean имена

Использовать:

```text
is
has
can
should
```

---

# 100. Не использовать:

```text
flag
bool
check
```

как имя boolean.

---

# 101. Handler внутри component:

```ts
handleSave
handleDelete
```

---

# 102. Callback prop:

```ts
onSave
onDelete
```

---

# 103. Не использовать `handleClick1`, `handleClick2`

---

# 104. Function names — глаголы

```ts
loadSong
saveSettings
formatDuration
```

---

# 105. Не использовать `doSomething`

---

# 106. Не использовать `processData` без конкретного смысла

---

# 107. Type names — существительные

```ts
Song
RecordingResult
PlaybackSnapshot
```

---

# 108. Interface префикс `I` не обязателен

Предпочитать:

```ts
interface Song
```

а не:

```ts
interface ISong
```

если проектом не выбрана обратная политика.

---

# 109. Не смешивать `IName` и `Name` хаотично

---

# 110. `type` vs `interface`

Использовать `interface` для object contracts, если это удобно.

Использовать `type` для:

```text
union
intersection
utility composition
alias
```

---

# 111. Не превращать выбор `type/interface` в религию

Главное — единообразие.

---

# 112. Discriminated unions использовать для state

---

# 113. Enum vs union

Для frontend state часто достаточно:

```ts
type Status = "idle" | "loading" | "ready";
```

---

# 114. `enum` использовать если нужен настоящий reusable runtime enum

---

# 115. Не создавать `enum`, если plain union проще

---

# 116. `as const`

Использовать для immutable literal arrays/objects.

```ts
const roles = ["host", "guest"] as const;
```

---

# 117. Извлечение union

```ts
type Role = (typeof roles)[number];
```

---

# 118. `typeof`

Использовать если тип действительно должен следовать за value.

---

# 119. Не выводить domain API type из случайного default object

Плохо:

```ts
const defaults = {...};
type Config = typeof defaults;
```

если Config является самостоятельным публичным contract.

---

# 120. Публичный contract лучше объявить явно

---

# 121. Utility Types использовать активно

Например:

```ts
Partial<T>
Required<T>
Readonly<T>
Pick<T, K>
Omit<T, K>
Record<K, V>
```

---

# 122. Но не создавать тип из цепочки 8 utility types

---

# 123. Если тип невозможно понять — дать ему имя

---

# 124. `Pick`

Использовать для component props из существующей domain модели, если это реально тот же contract.

---

# 125. Не злоупотреблять `Pick` если props имеют самостоятельный смысл

---

# 126. `Omit`

Использовать осторожно.

Не строить публичный type как:

```ts
Omit<Omit<Omit<...>>>
```

---

# 127. `Partial`

Не использовать для patch object, если не все поля действительно optional по бизнес-смыслу.

---

# 128. `Record`

Использовать для mapping закрытого набора ключей.

```ts
const labels: Record<Status, string> = {...};
```

---

# 129. `Readonly`

Использовать для immutable contracts.

---

# 130. `ReadonlyArray<T>`

Использовать для входов, которые не должны мутироваться.

---

# 131. Не писать `T[]` если функция обещает не менять массив и это важно

---

# 132. Generic constraints использовать

```ts
function getId<T extends { id: string }>(value: T) {
  return value.id;
}
```

---

# 133. Не делать generic, если функция работает только с Song

---

# 134. Generic должен реально расширять reuse

---

# 135. Generic type parameter называть понятно

Хорошо:

```ts
TItem
TValue
TKey
```

для сложных generic.

---

# 136. Один `T` допустим в простой функции

---

# 137. Не создавать 6 generic parameters без необходимости

---

# 138. Conditional types использовать осторожно

---

# 139. Mapped types использовать только если они упрощают публичный contract

---

# 140. Type-level programming не должна быть сложнее runtime логики

---

# 141. Template literal types использовать только при реальной пользе

---

# 142. Branded IDs допустимы

Например:

```ts
type SongId = string & { readonly __brand: "SongId" };
```

только если путаница ID реальна.

---

# 143. Не branding everything

---

# 144. `satisfies`

Использовать для проверки структуры без потери literal types.

```ts
const labels = {
  ready: "Ready",
  failed: "Failed"
} satisfies Record<Status, string>;
```

---

# 145. Предпочитать `satisfies` грубому `as`

---

# 146. Не использовать `as` ради подавления ошибки

---

# 147. `as` допустим, если runtime факт гарантирован boundary

---

# 148. Non-null assertion `!`

Запрещён по умолчанию.

Плохо:

```ts
song!.title
```

---

# 149. Вместо `!` проверять состояние

---

# 150. `!` допустим только если lifecycle действительно гарантирует значение и это документировано

---

# 151. `Object.freeze` редко нужен при нормальном immutable style

---

# 152. Не мутировать props

---

# 153. Не мутировать React state напрямую

---

# 154. Не мутировать arrays/objects, пришедшие извне, без contract

---

# 155. Immutable update использовать только на уровне нужного изменения

---

# 156. Не делать deep clone `JSON.parse(JSON.stringify(...))`

---

# 157. Для clone использовать structuredClone только если действительно нужен глубокий clone

---

# 158. Не deep-clone large state без причины

---

# 159. Dates

Не передавать `Date` через API contract, если backend возвращает строку.

---

# 160. На boundary использовать ISO string type

---

# 161. Парсить Date только там, где она реально нужна для UI

---

# 162. Не создавать `new Date()` повторно в render для одного значения

---

# 163. Formatter вынести/мемоизировать при необходимости

---

# 164. `Intl.DateTimeFormat`

Использовать вместо ручного форматирования дат.

---

# 165. `Intl.NumberFormat`

Использовать для locale-aware чисел.

---

# 166. `Intl.RelativeTimeFormat`

Использовать если нужен relative time.

---

# 167. Не делать собственный formatter валют/дат без причины

---

# 168. Strings

Использовать template literals:

```ts
`Song ${id}`
```

---

# 169. Не конкатенировать длинные строки через `+`

---

# 170. `.join()` использовать для объединения частей массива

---

# 171. Не использовать regex если хватает `.includes`, `.startsWith`, `.endsWith`

---

# 172. `.startsWith`

Использовать вместо:

```ts
value.indexOf(prefix) === 0
```

---

# 173. `.includes`

Использовать вместо:

```ts
value.indexOf(item) !== -1
```

---

# 174. `trim()` для пользовательского ввода

---

# 175. Не trim-ить данные автоматически, если пробелы имеют смысл

---

# 176. `toLocaleLowerCase` / locale-aware logic использовать только если действительно нужно

---

# 177. Для internal machine identifiers не использовать locale-aware casing

---

# 178. Numbers

Использовать `Number.isNaN`

вместо глобального `isNaN`.

---

# 179. Использовать `Number.isFinite`

---

# 180. Не использовать implicit coercion для numeric validation

---

# 181. `parseInt`

Всегда с radix при необходимости:

```ts
parseInt(value, 10);
```

---

# 182. Если нужна строгая числовая конверсия — `Number()`

---

# 183. `parseFloat` использовать осознанно, потому что он принимает хвост текста

---

# 184. Не сравнивать вычисленные float без tolerance, если точность важна

---

# 185. Clamp

```ts
const value = Math.min(max, Math.max(min, input));
```

---

# 186. Если clamp используется часто — helper

---

# 187. Не создавать helper для одной локальной операции

---

# 188. Default parameters

Использовать:

```ts
function load(limit = 20) {}
```

---

# 189. Не писать внутри:

```ts
limit = limit ?? 20;
```

если default parameter решает задачу.

---

# 190. Но помнить: default parameter срабатывает только для `undefined`, не для `null`

---

# 191. Parameter properties

В классах использовать:

```ts
class Client {
  constructor(private readonly transport: Transport) {}
}
```

если класс действительно нужен.

---

# 192. Не создавать class ради двух функций

---

# 193. Plain functions/modules предпочтительнее class без state/lifecycle

---

# 194. Class оправдан если есть:

```text
state
resource ownership
lifecycle
encapsulation
```

---

# 195. Constructor не делает heavy work

---

# 196. Constructor только сохраняет dependencies/state

---

# 197. Heavy initialization — explicit `start`, `connect`, `load`

---

# 198. Private fields

Использовать `private` или `#field` единообразно.

---

# 199. Не смешивать оба стиля хаотично

---

# 200. `readonly`

Использовать для dependencies/полей, которые не должны переназначаться.

---

# 201. Functions

Функция делает одну вещь.

---

# 202. Обычная функция целится в небольшой размер

---

# 203. Если функция >40–60 строк — проверить ответственность

---

# 204. Не выносить каждую строку в helper

---

# 205. Helper должен иметь смысловое имя

---

# 206. Не создавать `helper1`, `helper2`

---

# 207. Не создавать `utils` ради одной функции

---

# 208. Pure function предпочтительна для преобразований

---

# 209. Side effects отделять

---

# 210. Не делать side effects внутри `.map`

---

# 211. Не делать state mutation внутри selector

---

# 212. Selector pure

---

# 213. Formatter pure

---

# 214. Mapper pure

---

# 215. Event handler может иметь side effect, но должен быть коротким

---

# 216. Return early

---

# 217. Happy path читать сверху вниз

---

# 218. Не использовать nested `if` больше 2–3 уровней

---

# 219. Если вложенность растёт — guard clauses/functions

---

# 220. Не писать mega expression ради одной строки

---

# 221. Если выражение трудно прочитать — промежуточная переменная

---

# 222. Имя промежуточной переменной должно добавлять смысл

---

# 223. Не создавать переменную только ради:

```ts
const result = fn();
return result;
```

---

# 224. Но оставить её, если нужна для debug/meaning

---

# 225. React components

Functional components only.

---

# 226. Не использовать class components в новом коде

---

# 227. Props interface/type рядом с component

---

# 228. Не использовать `React.FC` обязательно

Обычный:

```ts
const Component = (props: Props) => ...
```

часто проще.

---

# 229. Не использовать `React.FC` только ради children

---

# 230. `children` объявлять явно, если компонент их принимает

---

# 231. Для children использовать:

```ts
ReactNode
```

---

# 232. Не использовать `JSX.Element` там, где нужен любой renderable content

---

# 233. Component должен возвращать понятный JSX

---

# 234. Не создавать огромные inline JSX expressions

---

# 235. Сложный condition вынести в переменную или отдельный component

---

# 236. Простое условие:

```tsx
{isLoading && <Spinner />}
```

---

# 237. Не использовать `condition && value`, если value может быть `0` и это важно

---

# 238. Для двух branches:

```tsx
{ready ? <Ready /> : <Loading />}
```

---

# 239. Не делать nested JSX ternary

---

# 240. Для 3+ состояний лучше switch/mapping/subcomponent

---

# 241. `.map` в JSX нормален

---

# 242. Key должен быть стабильным ID

---

# 243. Array index как key запрещён для mutable lists

---

# 244. Fragment shorthand использовать:

```tsx
<>
</>
```

---

# 245. Named Fragment только если нужен key

---

# 246. Не использовать wrapper div без необходимости

---

# 247. Semantic HTML использовать

---

# 248. `button` вместо clickable `div`

---

# 249. `label` для input

---

# 250. Не добавлять ARIA поверх корректной native semantics без причины

---

# 251. Props spreading

Использовать осторожно.

---

# 252. Не делать:

```tsx
<Component {...props} />
```

если нужно контролировать contract

и props приходят из внешнего источника.

---

# 253. Spread допустим для wrapper, который действительно проксирует component contract

---

# 254. Не прокидывать unknown DOM props случайно

---

# 255. Hooks

Вызывать только на верхнем уровне component/hook.

---

# 256. Не вызывать hook conditionally

---

# 257. Не вызывать hook внутри loop

---

# 258. Custom hook только если нужен React lifecycle/state

---

# 259. Не создавать hook для plain formatter

---

# 260. `useState`

Использовать для минимального локального state.

---

# 261. Не хранить derived state

---

# 262. Functional state update:

```ts
setCount(current => current + 1);
```

если next зависит от previous.

---

# 263. Не использовать stale state:

```ts
setCount(count + 1);
```

в async/parallel context.

---

# 264. `useReducer`

Использовать если transitions сложнее нескольких независимых state.

---

# 265. Не использовать reducer ради двух полей

---

# 266. `useMemo`

Только если:

```text
expensive calculation
referential stability реально важна
measured rerender issue
```

---

# 267. Не memoize дешёвый boolean

---

# 268. `useCallback`

Не использовать для каждой функции автоматически

---

# 269. Использовать если callback identity реально влияет на child/subscription

---

# 270. `React.memo`

Не default.

---

# 271. `useRef`

Использовать для:

```text
DOM ref
mutable value без rerender
imperative instance
```

---

# 272. Не использовать ref вместо нормального state

---

# 273. `useEffect`

Side effects only.

---

# 274. Не использовать effect для event reaction, если можно вызвать действие прямо в handler

---

# 275. Не делать:

```text
button click
→ setFlag
→ effect sees flag
→ call API
```

Если можно:

```text
button click
→ call API
```

---

# 276. Effect cleanup обязателен для subscription/timer/listener

---

# 277. `useLayoutEffect`

Использовать только если DOM measurement/update должен произойти до paint

---

# 278. Не использовать `useLayoutEffect` по умолчанию

---

# 279. `useId`

Использовать для accessible IDs, а не random ID generation для domain entity

---

# 280. Domain IDs приходят из authoritative system

---

# 281. Event handlers

Типизировать:

```ts
const handleChange = (event: ChangeEvent<HTMLInputElement>) => {}
```

если тип не выводится удобно.

---

# 282. Не писать `event: any`

---

# 283. Использовать `currentTarget`, если нужен именно элемент handler

---

# 284. Не путать `target` и `currentTarget`

---

# 285. Не хранить synthetic event для async логики

Сразу извлечь нужное значение.

---

# 286. Forms

Controlled/uncontrolled approach выбирать осознанно.

---

# 287. Не смешивать оба подхода случайно в одном поле

---

# 288. Trim/normalize делать в подходящий момент

Не обязательно на каждый keypress.

---

# 289. Validation message рядом с field

---

# 290. Не хранить одно и то же значение одновременно:

```text
inputValue
normalizedValue
savedValue
```

без явной причины.

---

# 291. Form submit блокирует duplicate submit

---

# 292. Async submit state explicit

```text
idle
submitting
success
error
```

---

# 293. API clients

Один transport layer.

---

# 294. Не делать `fetch` в component

---

# 295. Не строить URL вручную в каждом feature

---

# 296. Query params через `URLSearchParams`

---

# 297. Не конкатенировать query string вручную

---

# 298. HTTP method typed/centralized where useful

---

# 299. Response parsing centralized

---

# 300. Runtime validation external response where trust boundary требует

---

# 301. AbortSignal передавать в client method

---

# 302. Request cancellation не считается user-facing error

---

# 303. 404/409/422 и т.д. маппить на typed app errors

---

# 304. Не выбрасывать raw Response глубоко в UI

---

# 305. Retry policy не прятать внутри каждого вызова

---

# 306. Electron IPC

Все channels centralized.

---

# 307. Payload typed.

---

# 308. Runtime payload validated.

---

# 309. Request/response pattern единообразен.

---

# 310. Fire-and-forget IPC только для настоящих events

---

# 311. Commands обычно request/response

---

# 312. Не использовать channel name как случайную строку в component

---

# 313. Security

Никакого `eval`.

---

# 314. Никакого `new Function`.

---

# 315. `dangerouslySetInnerHTML` запрещён по умолчанию.

---

# 316. External URL validation обязательна.

---

# 317. Не вставлять external input в DOM как HTML.

---

# 318. Не доверять TypeScript на runtime boundary.

---

# 319. Storage

Не использовать localStorage напрямую в random component.

---

# 320. Storage adapter centralized.

---

# 321. JSON parse из storage может вернуть invalid data

Валидировать.

---

# 322. Storage read имеет fallback/migration strategy.

---

# 323. Не хранить большие объекты в localStorage.

---

# 324. Не хранить binary data в localStorage.

---

# 325. Не хранить secrets в localStorage.

---

# 326. CSS/classes

Использовать `mergeClasses` Fluent там, где это стандарт проекта.

---

# 327. Не строить className вручную через длинные тернарники, если helper делает это яснее.

---

# 328. Не использовать inline style для повторяемой styling policy.

---

# 329. Inline style допустим для dynamic numeric value.

---

# 330. Не создавать style object внутри render без причины, если он стабилен.

---

# 331. Использовать design tokens.

---

# 332. Не писать hex colors случайно.

---

# 333. Не писать arbitrary z-index.

---

# 334. Не дублировать CSS rule в нескольких местах без причины.

---

# 335. Naming CSS styles по смыслу.

---

# 336. Imports

Imports группировать единообразно.

---

# 337. Не использовать wildcard imports.

---

# 338. Не делать deep import в internal соседней feature.

---

# 339. Не использовать barrel, если он создаёт cycle.

---

# 340. Type-only imports:

```ts
import type { Song } from "./model";
```

---

# 341. Использовать `import type` для чистых типов.

---

# 342. Это уменьшает accidental runtime dependencies.

---

# 343. Не импортировать React целиком, если JSX transform это не требует и нужны только types/functions отдельно.

---

# 344. Но использовать единый стиль проекта.

---

# 345. Constants

Feature constants рядом с feature.

---

# 346. Не создавать giant `constants.ts`.

---

# 347. Magic strings state/action names запрещены.

---

# 348. Closed values → union/enum/constants.

---

# 349. Magic numbers UX behavior → named constant/policy.

---

# 350. Но не создавать `const ONE = 1`.

---

# 351. Date/time

Для animation использовать `performance.now()`.

---

# 352. Для wall time использовать Date/Intl.

---

# 353. Не смешивать wall clock и monotonic time concepts.

---

# 354. Не вычислять authoritative playback через Date.

---

# 355. Formatters централизовать, если используются много раз.

---

# 356. Search normalization helper centralized.

---

# 357. Duration formatter centralized.

---

# 358. File size formatter centralized.

---

# 359. Но не делать universal formatting framework.

---

# 360. Promise cleanup

Не оставлять floating Promise.

---

# 361. Promise либо `await`, либо intentional `void`.

---

# 362. Если используется:

```ts
void runAsync();
```

должно быть понятно, почему result намеренно не await.

---

# 363. Fire-and-forget Promise должен сам корректно обработать error.

---

# 364. Не писать `async` функцию, если нет `await` и Promise behavior не нужен.

---

# 365. Не возвращать Promise вручную из sync logic.

---

# 366. Events

Event names past tense, если описывают факт:

```text
playbackStarted
recordingFinished
```

---

# 367. Commands imperative:

```text
startPlayback
stopRecording
```

---

# 368. Не смешивать command и event naming.

---

# 369. Subscription callback получает typed event.

---

# 370. Event payload минимален.

---

# 371. Не отправлять giant global state в каждом event.

---

# 372. Для snapshots отдельный snapshot contract.

---

# 373. Stale event protection обязательна.

---

# 374. Service sequence/revision/generation учитывать.

---

# 375. Assertions

Не использовать `!` non-null assertion как substitute validation.

---

# 376. Не использовать `console.assert` для product validation.

---

# 377. Runtime invariant может иметь dedicated assertion helper.

---

# 378. Production user input никогда не полагается на dev assert.

---

# 379. Comments

Комментарий объясняет `why`.

---

# 380. Не комментировать очевидную строку.

---

# 381. Не оставлять commented-out code.

---

# 382. TODO concrete.

---

# 383. TODO имеет removal condition.

---

# 384. Не писать большие doc comments, повторяющие type signature.

---

# 385. JSDoc использовать для non-obvious public contract.

---

# 386. `@deprecated` только вместе с планом удаления.

---

# 387. Deprecated код не вечный.

---

# 388. Refactor

При замене реализации удалить старую.

---

# 389. Не оставлять:

```text
OldComponent
NewComponent
ComponentV2
FinalComponent
```

---

# 390. После migration:

```text
call sites switched
tests switched
old code deleted
old styles deleted
old hooks deleted
old types deleted
old flags deleted
```

---

# 391. Repository search старого имени обязателен.

---

# 392. Не оставлять compatibility wrapper без причины.

---

# 393. Git — backup.

---

# 394. Dead code удаляется.

---

# 395. Dead export удаляется.

---

# 396. Dead dependency удаляется.

---

# 397. Dead translation key удаляется.

---

# 398. Dead CSS удаляется.

---

# 399. Dead route удаляется.

---

# 400. Dead asset удаляется, если не нужен product spec.

---

# 401. Feature flags temporary.

---

# 402. Feature flag имеет owner/removal condition.

---

# 403. После rollout old branch удаляется.

---

# 404. Performance

Не оптимизировать без profiling.

---

# 405. Не использовать memoization everywhere.

---

# 406. Не создавать custom cache для дешёвого вычисления.

---

# 407. Large lists virtualization.

---

# 408. Images lazy load.

---

# 409. Heavy route lazy load.

---

# 410. Не lazy-load мелкие components.

---

# 411. Не хранить huge arrays в React state без причины.

---

# 412. Не сериализовать huge state через JSON ради clone.

---

# 413. Worker только для heavy frontend compute.

---

# 414. Worker не заменяет Python/AudioService.

---

# 415. Testing-friendly code

Pure functions для преобразований.

---

# 416. Side effects через boundaries.

---

# 417. Не прятать API call внутри formatter/selector.

---

# 418. Не прятать navigation внутри random utility.

---

# 419. Selector не мутирует state.

---

# 420. Mapper не делает network call.

---

# 421. Formatter не читает global state.

---

# 422. UI component не вызывает process-level API напрямую.

---

# 423. Utilities

Не создавать giant `utils.ts`.

---

# 424. Файл называется по конкретной задаче:

```text
formatDuration.ts
normalizeSearch.ts
clamp.ts
```

---

# 425. Но не создавать файл на одну строку без переиспользования/смысла.

---

# 426. Shared helper появляется после реального reuse.

---

# 427. DRY не абсолют.

---

# 428. Semantic duplication устранять.

---

# 429. Visual duplication можно оставить, если abstraction ухудшит код.

---

# 430. Public API

Feature экспортирует минимально нужное.

---

# 431. Не экспортировать internal hook/helper.

---

# 432. Не делать `export *` через десять уровней.

---

# 433. Prefer explicit exports.

---

# 434. Barrel небольшой.

---

# 435. Avoid deep import from foreign feature internals.

---

# 436. File naming

Components:

```text
SongCard.tsx
```

Hooks:

```text
useSongSearch.ts
```

Types:

```text
types.ts
```

только если они действительно scoped к feature.

---

# 437. Не создавать `types.ts` на весь проект.

---

# 438. API types рядом с client/domain contract.

---

# 439. Tests рядом или зеркально — выбрать один стиль и соблюдать.

---

# 440. Consistency важнее мелких вкусовых предпочтений.

---

# 441. Code review rule

Если строку можно сделать короче встроенным TypeScript/JS API без потери ясности — сделать.

---

# 442. Но не превращать код в code-golf.

---

# 443. Если один-liner сложнее трёх строк — оставить три строки.

---

# 444. Не использовать obscure operators ради красоты.

---

# 445. Не злоупотреблять comma operator.

---

# 446. Bitwise tricks запрещены для обычной application logic.

---

# 447. Не использовать `~~value` вместо `Math.trunc`.

---

# 448. Не использовать `x | 0` для numeric conversion.

---

# 449. Не использовать XOR tricks для swap.

---

# 450. Не использовать implicit coercion как optimization.

---

# 451. Readability > micro-shortening.

---

# 452. Built-in APIs first

Перед helper проверить:

```text
Array
Object
Map
Set
Promise
Intl
URL
URLSearchParams
structuredClone
```

---

# 453. Standard library > external dependency

---

# 454. External dependency > homegrown framework только если реально лучше.

---

# 455. Не изобретать собственный debounce, если уже есть approved utility.

---

# 456. Но не тащить lodash ради одного `debounce`, если можно маленький approved helper.

---

# 457. lodash-style imports tree-shake safe.

---

# 458. Не импортировать целую utility library ради одной функции.

---

# 459. `Map`

Использовать если keys не строки или нужна явная map semantics.

---

# 460. Plain object использовать для простого JSON-like record.

---

# 461. `Set`

Для uniqueness/membership.

---

# 462. Не использовать object как fake set.

---

# 463. `WeakMap`/`WeakSet`

Только для настоящей object-lifetime association.

---

# 464. Не использовать exotic structures без причины.

---

# 465. `Array.at`

Использовать:

```ts
items.at(-1)
```

если стиль проекта поддерживает target.

---

# 466. Не писать:

```ts
items[items.length - 1]
```

если `.at(-1)` читается лучше.

---

# 467. `findLast` / `findLastIndex`

Использовать при доступном target вместо reverse/copy.

---

# 468. Не делать:

```ts
[...items].reverse().find(...)
```

если есть `findLast`.

---

# 469. `flatMap`

Использовать если mapping возвращает 0..N элементов.

---

# 470. Не делать `.map(...).flat()` если `flatMap` яснее.

---

# 471. `Object.hasOwn`

Использовать:

```ts
Object.hasOwn(obj, key)
```

вместо:

```ts
obj.hasOwnProperty(key)
```

---

# 472. `structuredClone`

Использовать только если deep clone действительно нужен.

---

# 473. Не использовать JSON clone.

---

# 474. `URL`

Использовать вместо ручного разбора URL.

---

# 475. `URLSearchParams`

Для query params.

---

# 476. Не regex-ить URL вручную без причины.

---

# 477. `AbortController`

Стандартный механизм отмены fetch-like операций.

---

# 478. Не изобретать boolean `cancelled` если API уже поддерживает AbortSignal.

---

# 479. Cleanup controller при смене context.

---

# 480. Race-safe async

Старый response не перезаписывает новый state.

---

# 481. Sequence/revision/generation сравниваются перед apply.

---

# 482. Не использовать timestamp как суррогат sequence, если service уже имеет generation.

---

# 483. Default values

Не писать:

```ts
value || 0
```

если `0` валидно.

Использовать:

```ts
value ?? 0
```

---

# 484. Optional arrays

Не писать:

```ts
(items || []).map(...)
```

если:

```ts
(items ?? []).map(...)
```

правильнее.

---

# 485. Но лучше нормализовать collection один раз на boundary, если она должна всегда быть массивом.

---

# 486. Avoid optional everywhere

Если contract гарантирует значение — тип должен быть required.

---

# 487. Не ставить `?` на каждое поле API DTO «на всякий случай».

---

# 488. Optional означает реальную возможность отсутствия.

---

# 489. Не создавать тип:

```ts
interface Song {
  id?: string;
  title?: string;
  artist?: string;
}
```

если valid Song обязан иметь все поля.

---

# 490. Use separate draft/partial type, если incomplete state реально существует.

---

# 491. Narrowing

Использовать type guards.

---

# 492. `in` operator для discriminated structures where useful.

---

# 493. `instanceof` для class/runtime object.

---

# 494. Не использовать `typeof x === "object"` без проверки `x !== null`.

---

# 495. Custom type guard только если он реально повторяется/улучшает boundary.

---

# 496. Assertion function допустима для invariant boundary.

---

# 497. Но assertion не должна скрывать runtime validation external data.

---

# 498. Event maps

Для event bus/service event types использовать mapping type.

---

# 499. Не писать overload на десятки event names вручную, если typed map проще.

---

# 500. Но не строить universal event framework без необходимости.

---

# 501. Overloads

Использовать только если они реально улучшают caller typing.

---

# 502. Не создавать пять overloads вместо нормального discriminated options object.

---

# 503. Function options object

Если аргументов >3–4 и они одного контекста:

```ts
loadSong({
  songId,
  revision,
  preload
});
```

---

# 504. Не использовать positional booleans

Плохо:

```ts
loadSong(id, true, false);
```

---

# 505. Хорошо:

```ts
loadSong(id, {
  preload: true,
  force: false
});
```

---

# 506. Default options централизованы.

---

# 507. Не мутировать options внутри функции.

---

# 508. Return types

Публичной функции задавать return type, если contract важен.

---

# 509. Локальной маленькой функции позволять inference, если тип очевиден.

---

# 510. Не аннотировать очевидное:

```ts
const name: string = "A";
```

---

# 511. Type inference использовать активно.

---

# 512. Но boundary contracts задавать явно.

---

# 513. Не дублировать тип в значении без причины.

---

# 514. `satisfies` помогает сохранить inference.

---

# 515. `Readonly` для constant mappings.

---

# 516. Use `const` assertion для literal config.

---

# 517. Не over-type trivial local code.

---

# 518. React refs

Тип:

```ts
useRef<HTMLDivElement>(null);
```

---

# 519. Не использовать `any` ref.

---

# 520. Imperative handle использовать только если declarative props не решают задачу.

---

# 521. `forwardRef` только когда действительно нужен внешний ref contract.

---

# 522. Не использовать refs как скрытый communication channel между features.

---

# 523. Error boundaries

Не ловить render errors try/catch внутри component.

---

# 524. Использовать proper Error Boundary.

---

# 525. Async errors всё равно требуют отдельного handling.

---

# 526. Logging

Не оставлять `console.log`.

---

# 527. `console.error` тоже через logger where practical.

---

# 528. Не логировать весь object blindly.

---

# 529. Structured fields.

---

# 530. Не логировать sensitive/path data без необходимости.

---

# 531. Comments/TODO cleanup part of refactor.

---

# 532. Imports cleanup automatic/lint.

---

# 533. Unused variables запрещены.

---

# 534. Если параметр намеренно не используется — убрать его или назвать `_`/`_event` согласно lint policy.

---

# 535. Не оставлять `_unused` навсегда, если contract можно упростить.

---

# 536. No duplicate implementation

Если появился новый hook/component/client, старый должен исчезнуть после migration.

---

# 537. Один canonical path.

---

# 538. Не оставлять fallback path без documented compatibility reason.

---

# 539. Feature removal = cleanup.

---

# 540. Final code style rule

```text
SHORTER
≠
BETTER

CLEARER
+
SHORTER
=
BETTER
```

---

# 541. При выборе между двумя вариантами

Выбирать:

```text
1. Более понятный.
2. Более прямой.
3. Более типобезопасный.
4. Только потом — более короткий.
```

---

# 542. Если built-in syntax выражает intent прямо — использовать его

Например:

```text
?. 
??
??=
includes
some
every
find
Object.entries
Object.fromEntries
Set
Map
Promise.all
```

---

# 543. Если встроенный shortcut делает код неочевидным — не использовать

---

# 544. Не писать TypeScript как C#/Java

Использовать idioms языка.

---

# 545. Не писать TypeScript как code-golf JavaScript

Типобезопасность и intent важнее трюков.

---

# 546. Хороший код должен читаться почти как описание действия

---

# 547. Если одинаковый pattern встречается много раз — стандартизировать

---

# 548. Если pattern появился один раз — не создавать framework

---

# 549. Если новый API делает старый helper ненужным — удалить helper

---

# 550. Если новая language feature делает старый boilerplate ненужным — использовать новую feature, если она поддерживается project target

---

# 551. Но не использовать новую feature только потому, что она новая

---

# 552. Target compatibility проверяется один раз в project config

---

# 553. Код не должен вручную polyfill'ить возможности, уже гарантированные runtime/build target

---

# 554. Не писать compatibility code для browser versions, которые Electron никогда не использует

---

# 555. Но не полагаться на API, отсутствующее в target Electron/TS lib

---

# 556. ESLint rule нарушать только локально и с причиной

---

# 557. Type error не лечить `any`

---

# 558. Runtime error не лечить optional chaining везде

Плохо:

```ts
project?.song?.data?.id
```

если отсутствие `project` — нарушение invariant.

---

# 559. Optional chaining не должна скрывать bug

---

# 560. Если значение обязано быть — проверить/throw на boundary

---

# 561. `?? fallback` не должен скрывать corrupted backend state

---

# 562. Fallback использовать только если fallback является product behavior

---

# 563. Не превращать каждый error в пустой массив

Плохо:

```ts
const songs = response?.songs ?? [];
```

если отсутствие `songs` означает invalid response.

---

# 564. Normalize only valid optional fields.

---

# 565. Runtime validation for external contracts.

---

# 566. `never` использовать для exhaustive logic.

---

# 567. Не использовать `never` type tricks ради сложности.

---

# 568. Use stable immutable configuration objects.

---

# 569. Avoid deep mutable shared objects.

---

# 570. Functions receiving arrays should not mutate unless name/contract says so.

---

# 571. Prefer `toSorted()` when target supports it and immutable sort is desired.

---

# 572. Prefer `toReversed()` for immutable reverse when supported.

---

# 573. Prefer `toSpliced()` for immutable splice-style updates where supported.

---

# 574. Не использовать новые методы, если target/runtime их не гарантирует.

---

# 575. Не копировать array только ради `.sort()` если mutation локальной копии уже безопасна и понятна.

---

# 576. Использовать immutable метод там, где он делает intent яснее.

---

# 577. Grouping logic

Если runtime поддерживает `Object.groupBy` / `Map.groupBy`, использовать только если target гарантирует поддержку.

---

# 578. Иначе простой reducer/helper.

---

# 579. Не добавлять polyfill ради одного convenience method.

---

# 580. React rendering conditions

Если component может ничего не рендерить:

```tsx
if (!visible) return null;
```

часто проще большого ternary.

---

# 581. Guard component early.

---

# 582. Не вычислять heavy derived data до early-return, если оно не нужно.

---

# 583. Сначала cheap guards, потом expensive calculations.

---

# 584. Не делать async работу в render.

---

# 585. Не создавать Promise в render.

---

# 586. Не делать side effect в render.

---

# 587. Render должен быть pure.

---

# 588. Не читать mutable singleton в render без subscription mechanism.

---

# 589. External store подключать корректно, например через `useSyncExternalStore`, если подходит.

---

# 590. Не изобретать custom subscription hook без необходимости, если React API решает задачу.

---

# 591. Error message mapping one place.

---

# 592. Labels mapping one place.

---

# 593. Status badge mapping one place.

---

# 594. Permission gating one place.

---

# 595. Repeated route building one place.

---

# 596. Repeated duration formatting one place.

---

# 597. Repeated service retry policy one place.

---

# 598. Repeated validation boundary one place.

---

# 599. Но не создавать universal mega-helper.

---

# 600. Финальный принцип

```text
TYPECRIPT CODE STYLE
=
DIRECT INTENT
+
STRONG TYPES
+
MINIMUM BOILERPLATE
+
NO CLEVER MAGIC
```

---

# 601. Статус

```text
TYPESCRIPT FRONTEND CODE STYLE RULES
=
LOCKED
```
# Дополнительные обязательные правила

## Деструктуризация

### 1. Использовать деструктуризацию, если она уменьшает шум

Хорошо:

```ts
const { title, artist, status } = song;
```

вместо:

```ts
const title = song.title;
const artist = song.artist;
const status = song.status;
```

---

### 2. Не деструктурировать весь объект без необходимости

Плохо:

```ts
const {
  id,
  title,
  artist,
  album,
  duration,
  status,
  revision,
  createdAt,
  updatedAt,
  cover,
  language,
  path
} = song;
```

если используются только:

```ts
song.title
song.artist
```

---

### 3. Деструктурировать только реально используемые поля

---

### 4. Props желательно деструктурировать

```tsx
const SongCard = ({ song, onPlay, onDelete }: Props) => {
```

если список props небольшой.

---

### 5. Если props много — не делать огромную сигнатуру

В таком случае:

```tsx
const SongCard = (props: Props) => {
  const { song, onPlay } = props;
```

может читаться лучше.

---

### 6. Не делать глубокую деструктуризацию

Плохо:

```ts
const {
  project: {
    metadata: {
      artist: { name }
    }
  }
} = data;
```

Лучше:

```ts
const artistName = data.project.metadata.artist.name;
```

или выделить нормальную модель.

---

### 7. Не использовать destructuring, если теряется контекст

Иногда:

```ts
song.title
song.artist
song.status
```

читается лучше, чем:

```ts
title
artist
status
```

особенно когда рядом несколько сущностей.

---

### 8. Не деструктурировать два похожих объекта без alias

Плохо:

```ts
const { id, status } = song;
const { id, status } = recording;
```

Правильно:

```ts
const { id: songId, status: songStatus } = song;
const { id: recordingId, status: recordingStatus } = recording;
```

---

### 9. Rest destructuring использовать только когда остаток действительно нужен

```ts
const { id, ...payload } = item;
```

---

### 10. Не использовать rest только ради удаления одного поля, если это делает код менее понятным

---

# State Update — запрет переполнения React state

## 11. React state нельзя обновлять чаще, чем UI способен отрисовать

Критическое правило:

```text
SERVICE EVENT RATE
≠
REACT STATE UPDATE RATE
```

---

## 12. Не делать `setState` на каждый audio callback

Запрещено:

```text
Audio callback 480 раз/сек
→ 480 setState/сек
```

---

## 13. Не делать `setState` на каждый PCM block

---

## 14. Не делать `setState` на каждый pitch frame

---

## 15. Не делать `setState` на каждый remote voice packet

---

## 16. Не делать `setState` на каждый network event

---

## 17. Для визуального realtime UI использовать ограниченную частоту

Например:

```text
30–60 UI updates/sec
```

для:

```text
playback position
pitch visualization
levels
meters
```

---

## 18. Для менее важных данных использовать ещё меньшую частоту

Например:

```text
5–15 Hz
```

для diagnostics/meters, если этого достаточно.

---

## 19. Сервис может обновляться чаще, чем React

Например:

```text
AudioService:
1000 events/sec

React:
30 snapshots/sec
```

---

## 20. Старые realtime snapshots должны заменяться новым

Не нужно обрабатывать очередь:

```text
snapshot1
snapshot2
snapshot3
...
snapshot500
```

если важен только последний.

---

## 21. Использовать latest-value/coalescing model

```text
incoming events
↓
latest snapshot
↓
requestAnimationFrame / throttle
↓
React update
```

---

## 22. Не накапливать очередь UI updates

---

## 23. Для playback position frontend получает authoritative snapshot

Между snapshots визуально интерполирует через:

```ts
requestAnimationFrame
```

без `setState` каждый frame.

---

## 24. `requestAnimationFrame` не обязан делать `setState`

Можно обновлять:

```text
canvas
WebGL
ref
imperative visualizer
```

без полного React render.

---

## 25. Высокочастотные значения хранить в `useRef`, если они не требуют render

Например:

```ts
const latestPositionRef = useRef(0);
```

---

## 26. `useRef` подходит для latest realtime value

Если:

```text
значение нужно callback/visualizer
но не должно rerender UI
```

---

## 27. Не заменять весь state большим новым object на каждый realtime event

Плохо:

```ts
setAudioState({
  playback,
  mic,
  levels,
  diagnostics,
  participants,
  recording,
  ...
});
```

60 раз в секунду.

---

## 28. Разделять state по частоте обновления

Например:

```text
slow state:
song
recording status
device state

fast state:
position
pitch
level
```

---

## 29. Slow и fast state не должны жить в одном giant Context

---

## 30. Иначе изменение `level` rerender'ит весь интерфейс

---

## 31. Частые external updates лучше читать через selector subscription

---

## 32. Использовать `useSyncExternalStore`, если external store подходит под модель

---

## 33. Не копировать весь external store в React `useState`

---

## 34. Subscribe только на нужный slice

Плохо:

```text
subscribe entire AudioService state
```

для компонента, которому нужен только:

```text
isRecording
```

---

## 35. Selector должен возвращать минимальный state

---

## 36. Не создавать новый object из selector каждый event без необходимости

Плохо:

```ts
state => ({
  position: state.position,
  level: state.level
})
```

если store сравнивает по reference и это вызывает rerender каждый раз.

---

## 37. Использовать primitive selectors или stable comparison

---

## 38. Не вызывать несколько `setState` подряд без причины

Плохо:

```ts
setLoading(false);
setError(null);
setData(result);
```

если это один lifecycle.

Лучше:

```ts
setState({
  status: "ready",
  data: result
});
```

---

## 39. Связанные поля должны обновляться атомарно

---

## 40. Не создавать inconsistent intermediate state

Например:

```text
loading = false
data = undefined
error = undefined
```

между несколькими setState.

---

## 41. Для сложного lifecycle использовать discriminated union/reducer

---

## 42. Functional update обязателен, если next state зависит от previous

```ts
setCount(current => current + 1);
```

---

## 43. Не использовать stale value

Плохо:

```ts
setItems([...items, newItem]);
```

если update может происходить конкурентно.

Лучше:

```ts
setItems(current => [...current, newItem]);
```

---

## 44. Не делать state update внутри tight loop

Плохо:

```ts
for (const item of items) {
  setResults(current => [...current, item]);
}
```

---

## 45. Сначала собрать результат, потом один update

```ts
const results = items.map(transform);
setResults(results);
```

---

## 46. Не делать `setState` внутри `.map()`

---

## 47. Не делать `setState` внутри `.forEach()` для каждого элемента

---

## 48. Batch changes до одного update

---

## 49. React batching не оправдывает плохую архитектуру

Даже если React может batch updates, не нужно генерировать сотни бессмысленных updates.

---

## 50. Не использовать state для значения, которое меняется очень часто и не влияет на JSX

Использовать ref/external store/renderer engine.

---

## 51. Canvas/WebGL animation data не хранить каждый frame в React state

---

## 52. Visualizer получает realtime data напрямую через controlled bridge/ref

---

## 53. React управляет lifecycle visualizer, а не каждым frame

---

## 54. Dragging Editor не должен обязательно сохранять каждое движение в heavyweight global state

---

## 55. Во время drag можно использовать transient local/ref state

---

## 56. Commit meaningful change в editor state делать с разумной частотой

---

## 57. Undo history не создавать на каждый `pointermove`

---

## 58. Один drag gesture обычно = одна undo operation

---

## 59. Pointer events нужно coalesce/throttle при тяжёлой обработке

---

## 60. Search input не должен запускать backend query на каждую клавишу без policy

---

## 61. Remote search использовать debounce

Например:

```text
150–300 ms
```

по UX policy.

---

## 62. Локальный search debounce не нужен, если вычисление дешёвое

---

## 63. Resize events throttle/debounce

---

## 64. Scroll events не должны делать тяжелый `setState` на каждый event

---

## 65. Использовать `requestAnimationFrame` для scroll-related visual updates

---

## 66. Window resize не должен rerender всё приложение десятки раз без необходимости

---

## 67. Device/audio diagnostic stream должен иметь UI sampling rate

---

## 68. Room speaking levels должны coalesce

---

## 69. Каждый participant level не должен создавать отдельный global update каждую миллисекунду

---

## 70. Обновлять только реально изменившиеся participant slices

---

## 71. Не пересоздавать массив всех participants из-за изменения одного level, если store может обновить slice

---

## 72. Но не вводить сложную normalized architecture, если участников 3 и performance проблемы нет

---

## 73. Сначала правильная boundary, потом optimization

---

# State shape

## 74. State должен быть минимальным

Хранить только то, что невозможно надёжно получить из других state/props.

---

## 75. Не хранить:

```text
fullName
```

если есть:

```text
firstName
lastName
```

и вычисление дешёвое.

---

## 76. Не хранить:

```text
isEmpty
```

если есть:

```ts
items.length === 0
```

---

## 77. Не хранить:

```text
hasError
```

если есть:

```ts
status === "error"
```

---

## 78. Не хранить:

```text
progressPercent
```

отдельно, если он напрямую вычисляется из authoritative progress fields.

---

## 79. Не хранить props в state без причины

Плохо:

```ts
const [song, setSong] = useState(props.song);
```

если state должен просто отображать prop.

---

## 80. Props → state только для настоящего draft

Например Editor draft.

---

## 81. Draft должен иметь явное lifecycle

```text
load
edit
save
discard
reload
```

---

## 82. Не синхронизировать prop → state через effect без необходимости

---

## 83. Если prop должен всегда выигрывать — использовать prop напрямую

---

# Derived state

## 84. `useMemo` допустим для дорогого derived state

---

## 85. Не использовать `useMemo` только чтобы избежать `const`

---

## 86. Простое:

```ts
const isReady = song.status === "ready";
```

не требует `useMemo`.

---

## 87. Filter/sort большого списка может требовать memo

---

## 88. Но сначала измерить performance

---

# State ownership

## 89. State хранится максимально близко к потребителю

---

## 90. Не поднимать state наверх без необходимости

---

## 91. Lift state только если несколько siblings действительно должны его разделять

---

## 92. Не помещать local modal state в global store

---

## 93. Не помещать hover/focus state в global store

---

## 94. Не помещать input draft в global store без product reason

---

## 95. Global state только для действительно global/shared state

---

# Setter naming

## 96. Для boolean state:

```ts
const [isOpen, setIsOpen] = useState(false);
```

---

## 97. Не использовать:

```ts
const [open, setState] = ...
```

если имя setter становится непонятным.

---

## 98. Для complex state generic `setState` допустим только внутри маленького scoped hook/component

---

## 99. В больших feature лучше semantic actions

Например:

```text
openDialog
closeDialog
selectSong
```

вместо передачи raw setter наружу.

---

## 100. Не передавать `setState` child-компонентам без необходимости

---

## 101. Child получает semantic callback

Хорошо:

```tsx
onSelectSong(songId)
```

Плохо:

```tsx
setSelectedSong
```

---

# Финальное правило State

## 102.

```text
REACT STATE
НЕ ЯВЛЯЕТСЯ
ПОТОКОМ TELEMETRY
```

---

## 103.

```text
FAST DATA
→ REF / EXTERNAL STORE / RENDER ENGINE

MEANINGFUL UI STATE
→ REACT STATE
```

---

## 104.

```text
ONE USER-RELEVANT CHANGE
≈
ONE MEANINGFUL STATE UPDATE
```

а не десятки промежуточных setters.

---

## 105.

```text
SERVICE MAY RUN AT 1000 Hz

REACT DOES NOT NEED TO
```

---

## 106. Главное правило деструктуризации

```text
DESTRUCTURE
WHEN IT REMOVES NOISE

DO NOT DESTRUCTURE
WHEN IT REMOVES CONTEXT
```

---

## 107. Главное правило `setState`

```text
SET STATE
ONLY WHEN
THE UI MEANINGFULLY CHANGED
```

---

## 108. Главное правило realtime

```text
REALTIME DATA
MUST BE SAMPLED / COALESCED
BEFORE IT BECOMES REACT STATE
```
# Frontend — универсальные правила JSX / TSX / HTML

**Stack**

```text
React
TypeScript
TSX
Theme UI kit (src/theme/ui)
Electron
```

**Статус**

```text
JSX / TSX / HTML STYLE RULES
=
LOCKED
```

## Главный принцип

```text
РАЗМЕТКА ДОЛЖНА БЫТЬ
МАКСИМАЛЬНО ПРОСТОЙ,
ПЛОСКОЙ,
СЕМАНТИЧНОЙ
И БЕЗ ЛИШНИХ ОБЁРТОК.
```

---

# 1. Не создавать лишний wrapper

Плохо:

```tsx
<div>
  <div>
    <Text>Title</Text>
  </div>
</div>
```

Хорошо:

```tsx
<Text>Title</Text>
```

---

# 2. Каждый wrapper должен иметь причину

Причины:

```text
layout
styling
semantic grouping
event boundary
accessibility
portal/layer
```

Если причины нет — wrapper удалить.

---

# 3. Не использовать `div` автоматически

Сначала подумать, подходит ли:

```text
section
header
main
nav
article
aside
footer
form
button
label
ul
ol
li
```

---

# 4. Семантический HTML предпочтительнее generic `div`

---

# 5. `button` вместо `div onClick`

Плохо:

```tsx
<div onClick={onSave}>Save</div>
```

Хорошо:

```tsx
<Button onClick={onSave}>Save</Button>
```

---

# 6. Ссылка — это ссылка

Для navigation использовать:

```html
<a>
```

или router link.

Не clickable div.

---

# 7. `ul/li` для настоящего списка

---

# 8. Не использовать список только ради визуального layout

Если это не список по смыслу, обычный container лучше.

---

# 9. `header` для header section

---

# 10. `main` должен быть один основной на screen/document

---

# 11. `nav` только для navigation

---

# 12. `section` должен иметь смысловую секцию

Не использовать `section` как замену `div` везде.

---

# 13. Не использовать heading только ради размера текста

---

# 14. Heading hierarchy должна быть логичной

```text
h1
→ h2
→ h3
```

---

# 15. Не прыгать случайно с `h1` на `h4`

---

# 16. Один screen обычно имеет один главный heading

---

# 17. Для Fluent Text сохранять semantic role where required

---

# 18. Не рендерить heading как обычный `span`, если он реально heading

---

# 19. Fragment вместо ненужного wrapper

```tsx
<>
  <Header />
  <Content />
</>
```

---

# 20. Named Fragment нужен только если нужен `key`

---

# 21. Не использовать Fragment вокруг одного child

---

# 22. JSX дерево должно быть максимально плоским

---

# 23. Глубокая вложенность — warning

Если JSX выглядит:

```text
div
  div
    div
      div
        component
```

проверить layout.

---

# 24. Не использовать wrapper только ради className, если class можно дать существующему element

---

# 25. Но не ломать semantic element ради удаления одного wrapper

---

# 26. Не использовать wrapper для каждого текста

Плохо:

```tsx
<div>
  <span>
    <Text>Title</Text>
  </span>
</div>
```

---

# 27. Избегать пустых layout containers

---

# 28. Удалять container, если после refactor он больше ничего не делает

---

# Условный render

## 29. Простое условие

```tsx
{isVisible && <Content />}
```

---

## 30. Не использовать `&&`, если слева может быть `0`

Например:

```tsx
{count && <Badge>{count}</Badge>}
```

может вывести `0`.

Лучше:

```tsx
{count > 0 && <Badge>{count}</Badge>}
```

---

## 31. Два состояния — ternary допустим

```tsx
{isLoading ? <Spinner /> : <Content />}
```

---

## 32. Не делать nested ternary в JSX

Плохо:

```tsx
{loading ? (
  <Spinner />
) : error ? (
  <Error />
) : empty ? (
  <Empty />
) : (
  <Content />
)}
```

---

## 33. Для 3+ состояний предпочитать early return

```tsx
if (loading) return <Spinner />;
if (error) return <ErrorState />;
if (empty) return <EmptyState />;

return <Content />;
```

---

## 34. Или выделить state renderer/component

---

## 35. Не создавать component только ради одного ternary

---

## 36. Не использовать giant `renderContent()` внутри component на 150 строк

---

## 37. Если render branch сложный — отдельный component

---

## 38. Но если branch 3 строки — оставить inline

---

# Повторяющаяся разметка

## 39. Если повторяется одинаковый блок с разными данными — использовать `.map`

```tsx
{actions.map(action => (
  <Button key={action.id} onClick={action.onClick}>
    {action.label}
  </Button>
))}
```

---

## 40. `.map` хорош, когда различаются только данные

---

## 41. Не использовать `.map`, если каждый item имеет сильно разное behavior

---

## 42. Не создавать giant config-driven renderer

Плохо:

```text
type
icon
layout
permission
visibility
renderer
renderer2
renderer3
```

ради сокращения 30 строк JSX.

---

## 43. Config-driven UI только для устойчивого повторяющегося pattern

---

## 44. Два похожих блока не всегда требуют map

---

## 45. Три+ одинаковых data-driven блока — хороший кандидат

---

## 46. Не хранить JSX в config без причины

Плохо:

```ts
const items = [
  { content: <HugeBlock /> }
];
```

если лучше хранить данные.

---

## 47. Данные отдельно, UI отдельно

---

## 48. Иконки в config допустимы для простых action mappings

---

# Lists

## 49. Каждый `.map` имеет stable key

---

## 50. Использовать entity ID

```tsx
key={song.id}
```

---

## 51. Не использовать index как key для mutable list

---

## 52. Index допустим только для полностью статичного списка без reorder/add/remove

---

## 53. Не генерировать random key в render

Плохо:

```tsx
key={Math.random()}
```

---

## 54. Не использовать `Date.now()` как key

---

## 55. Key не должен меняться между renders

---

# Props в JSX

## 56. Простые props писать компактно

```tsx
<Button
  disabled={isDisabled}
  onClick={onSave}
>
  Save
</Button>
```

---

## 57. Не писать boolean prop как:

```tsx
<Button disabled={true} />
```

если можно:

```tsx
<Button disabled />
```

---

## 58. Но для computed boolean оставить явное значение

---

## 59. Не передавать prop со значением `undefined` без необходимости

---

## 60. Не писать:

```tsx
<Component value={condition ? value : undefined} />
```

если prop можно просто условно не передавать и это улучшает ясность.

---

## 61. Не использовать object spread для всех props без контроля

Плохо:

```tsx
<Component {...props} />
```

если component не является wrapper/proxy.

---

## 62. Spread допустим для настоящего passthrough wrapper

---

## 63. Не передавать DOM неизвестные props случайно

---

## 64. Destructure props, если это уменьшает шум

---

## 65. Не destructure 20 props в сигнатуре

---

## 66. Если props много — это architecture warning

---

# Event handlers

## 67. Простое действие можно inline

```tsx
<Button onClick={() => setOpen(true)} />
```

---

## 68. Не выносить handler только потому, что он существует

---

## 69. Но сложный handler должен иметь имя

```tsx
<Button onClick={handleSave} />
```

---

## 70. Не писать 10 строк логики внутри `onClick`

---

## 71. Не писать async block прямо в JSX

Плохо:

```tsx
<Button
  onClick={async () => {
    ...
    ...
    ...
  }}
/>
```

---

## 72. Выносить meaningful async handler

---

## 73. Не вызывать handler при render

Плохо:

```tsx
onClick={handleSave()}
```

---

## 74. Передавать функцию

```tsx
onClick={handleSave}
```

---

## 75. Не создавать wrapper lambda без причины

Плохо:

```tsx
onClick={() => handleSave()}
```

если можно:

```tsx
onClick={handleSave}
```

---

## 76. Lambda нужна, если передаются аргументы

```tsx
onClick={() => handleDelete(song.id)}
```

---

# Text / children

## 77. Статический текст писать прямо child

```tsx
<Button>Save</Button>
```

---

## 78. Не создавать переменную для одноразового `"Save"`

---

## 79. Все user-facing strings через localization layer, если проект локализован

---

## 80. Не смешивать translated и hardcoded strings

---

## 81. Не писать:

```tsx
<Text>{`${title}`}</Text>
```

если:

```tsx
<Text>{title}</Text>
```

---

## 82. Не использовать fragment вокруг одного text child

---

## 83. Не использовать `<span>` только ради одного текста, если компонент уже рендерит правильный element

---

# Forms

## 84. `label` должен быть связан с input

---

## 85. Если Fluent component уже решает label — не дублировать HTML label

---

## 86. Input не должен иметь placeholder вместо label

---

## 87. Placeholder не заменяет accessible name

---

## 88. Error message связан с field

---

## 89. Required state должен быть визуально и семантически понятен

---

## 90. Не создавать свой checkbox из div

---

## 91. Не создавать свой select, если Fluent Select/Dropdown подходит

---

## 92. Не создавать свой button-like element

---

## 93. Не использовать `<br />` для layout

---

## 94. Использовать CSS gap/margin

---

## 95. `<br />` только как реальный line break текста

---

# Theme UI kit (ранее Fluent UI)

> **Design system проекта:** вместо Fluent UI используется собственный **Theme UI kit** (`src/theme/ui`) вместе с Formik для форм (`GetForm`/`RenderFormikFields`). Каждое правило ниже, где названы Fluent или его компоненты, применяется к соответствующему компоненту kit (Button, IconButton, TextField, Select, Switch, Slider, Modal, Popover, Tooltip, Tabs, Grid и т. д.) и его tokens.

## 96. Fluent component предпочтительнее самописного аналога

---

## 97. Не оборачивать Fluent Button в custom button без policy

---

## 98. Wrapper нужен, если добавляет:

```text
общий style
общую accessibility policy
общое behavior
```

---

## 99. Не создавать wrapper ради default size одного экрана

---

## 100. Fluent props использовать напрямую, если это не создаёт duplication

---

## 101. `mergeClasses` для объединения Fluent classes

---

## 102. Не строить className вручную огромной строкой

---

## 103. Не использовать третью classnames-library без необходимости, если Fluent уже решает задачу

---

## 104. Fluent Dialog вместо собственного modal engine

---

## 105. Fluent Menu вместо собственного dropdown menu

---

## 106. Fluent Tooltip вместо собственного tooltip

---

## 107. Не смешивать Fluent и другой design system в одном screen

---

# Accessibility / semantics

## 108. Icon-only control имеет accessible label

---

## 109. Decorative icon скрыта от screen reader where appropriate

---

## 110. Не добавлять `role="button"` на настоящий `<button>`

---

## 111. Не добавлять ARIA, если native semantics уже правильная

---

## 112. ARIA не должна конфликтовать с native behavior

---

## 113. Dialog имеет accessible title

---

## 114. Form control имеет accessible name

---

## 115. Error alert использует подходящую semantics

---

## 116. Navigation landmark использовать по смыслу

---

## 117. Не использовать heading только для styling

---

## 118. Tab UI использовать Fluent Tabs / правильную tab semantics

---

## 119. Не строить fake tabs из div

---

## 120. Menu actions keyboard accessible

---

# JSX complexity

## 121. Один return не должен быть гигантским JSX на 300 строк

---

## 122. Если return не помещается нормально на экран — проверить composition

---

## 123. Но не дробить каждый блок в component ради line count

---

## 124. Сначала выделять настоящие semantic sections

---

## 125. JSX должен читаться сверху вниз как структура screen

---

## 126. Верхний уровень page должен выглядеть примерно:

```tsx
<Page>
  <Header />
  <Toolbar />
  <Content />
</Page>
```

а не содержать сразу все детали children.

---

## 127. Page composition не должна содержать low-level button markup повсюду

если это отдельные feature sections.

---

## 128. Повторяющийся section layout можно переиспользовать

---

## 129. Но generic `SectionRenderer` на все случаи не нужен

---

# Inline logic

## 130. Не вычислять сложные данные внутри JSX

Плохо:

```tsx
{songs
  .filter(...)
  .sort(...)
  .map(...)
}
```

если chain сложный.

---

## 131. Подготовить данные перед return

```ts
const visibleSongs = ...
```

---

## 132. Простая `.map` inline нормальна

---

## 133. Не делать API/data mutation внутри JSX expression

---

## 134. JSX render должен быть pure

---

## 135. Не использовать assignment внутри JSX

---

## 136. Не использовать comma operator в JSX

---

## 137. Не использовать IIFE в JSX без крайней причины

Плохо:

```tsx
{(() => {
  ...
})()}
```

---

## 138. Если IIFE нужен — почти всегда лучше helper/component

---

# Conditions / classes

## 139. Simple class condition через `mergeClasses`

---

## 140. Не создавать 5 вложенных ternary для className

---

## 141. Если классов много по state — mapping

---

## 142. Не смешивать styling state и business state без необходимости

---

# Layout

## 143. Использовать CSS Grid/Flexbox, а не лишние wrappers

---

## 144. `gap` предпочтительнее margin между каждым child

---

## 145. Не добавлять `margin-bottom` каждому item в вертикальном stack, если parent `gap` решает задачу

---

## 146. Grid использовать для двухмерного layout

---

## 147. Flex — для одномерного

---

## 148. Не использовать absolute positioning для обычного layout

---

## 149. Absolute только для layer/overlay/positioned visual

---

## 150. Не использовать fixed coordinates для responsive content

---

## 151. Не создавать layout через пустые элементы

---

## 152. Не использовать non-breaking spaces для spacing

---

# CSS/markup balance

## 153. Не переносить structural layout в JS inline style без причины

---

## 154. Не создавать separate wrapper только потому, что CSS selector неудобный

---

## 155. Но не использовать fragile CSS selector chain вместо нормального class

---

## 156. Не завязываться на internal DOM Fluent component

---

## 157. Styling должен работать через documented slots/classes/API

---

# Images

## 158. `<img>` имеет `alt`

---

## 159. Decorative image использует пустой `alt=""`

---

## 160. Не писать filename как alt

---

## 161. Cover image имеет понятный fallback

---

## 162. Broken image не ломает layout

---

## 163. Width/height/aspect ratio определены, чтобы уменьшать layout shift

---

## 164. Не грузить full-size image, если нужен thumbnail

---

# Media

## 165. `<video>` background muted

---

## 166. Не полагаться на video audio

---

## 167. Autoplay behavior учитывает Electron/runtime policy

---

## 168. Video element cleanup при смене source

---

## 169. Не держать несколько hidden videos playing

---

# Tables

## 170. Настоящие табличные данные — `<table>`/Fluent DataGrid

---

## 171. Не имитировать таблицу div-ами без причины

---

## 172. Table header semantic

---

## 173. Actions column отдельно

---

## 174. Не использовать table для layout страницы

---

# Forms markup

## 175. Form submit через `<form onSubmit>`, если это реальная форма

---

## 176. Не ловить Enter вручную в каждом input, если form semantics уже решает

---

## 177. Submit button имеет `type="submit"`

---

## 178. Secondary button в form явно `type="button"` where native button used

---

## 179. Не полагаться на default button type случайно

---

# Dialogs / overlays

## 180. Один dialog отвечает за одну задачу

---

## 181. Не строить dialog внутри dialog без крайней необходимости

---

## 182. Не открывать modal поверх modal, если flow можно сделать одним dialog

---

## 183. Confirmation dialog короткий

---

## 184. Большой settings flow лучше отдельным screen/panel, а не гигантским modal

---

## 185. Modal content не дублируется между несколькими dialog implementations

---

# Menus

## 186. Меню содержит actions, не огромную форму

---

## 187. Не помещать сложный screen внутрь popover

---

## 188. Popover для компактного contextual UI

---

## 189. Long-running workflow не должен жить внутри transient popover

---

# Tooltips

## 190. Tooltip не должен содержать критическую информацию, недоступную другим способом

---

## 191. Не добавлять tooltip к каждому тексту

---

## 192. Tooltip для truncated/ambiguous/icon control where useful

---

# Empty / loading states

## 193. Не делать:

```tsx
return null;
```

для loading, если пользователь должен понимать что происходит.

---

## 194. Empty state отдельный

---

## 195. Error state отдельный

---

## 196. Не использовать один spinner для всех состояний

---

## 197. Skeleton только если улучшает perceived loading

---

# Component boundaries

## 198. Выносить блок, если он имеет собственный смысл

Например:

```text
LibraryToolbar
SongGrid
ProcessingBanner
```

---

## 199. Не выносить:

```text
SongTitleWrapper
SongArtistWrapper
```

без reuse/behavior.

---

## 200. Component API должен быть меньше его implementation

---

## 201. Если component принимает 25 props — boundary плохой

---

## 202. Если component нужен только одному parent и состоит из 4 строк — оставление inline часто лучше

---

## 203. Но если эти 4 строки имеют отдельную семантику и повторяются — component оправдан

---

# Reuse

## 204. Переиспользование не является целью любой ценой

---

## 205. Shared component создаётся после устойчивого повторения

---

## 206. Не создавать `UniversalCard`

---

## 207. Не создавать `UniversalModal`

---

## 208. Generic component должен уменьшать complexity, а не переносить её в props

---

## 209. Если generic component имеет десятки flags:

```text
showX
hideY
compact
large
variantA
variantB
```

скорее всего он слишком универсальный.

---

## 210. Лучше два простых components, чем один monster component

---

# TSX expressions

## 211. Не использовать function calls с side effects в render

---

## 212. Pure formatter function допустима

```tsx
<Text>{formatDuration(duration)}</Text>
```

---

## 213. Expensive function нельзя вызывать повторно в JSX

---

## 214. Посчитать один раз перед render

---

## 215. Не делать:

```tsx
{calculate(song)}
...
{calculate(song)}
```

---

# Inline objects

## 216. Не создавать inline object prop каждую render, если child зависит от reference equality и это реально важно

---

## 217. Но не memoize inline objects автоматически

---

## 218. Если reference stability не имеет значения — обычный inline object допустим

---

# Styles

## 219. Dynamic style маленький:

```tsx
style={{ width: `${progress}%` }}
```

допустим.

---

## 220. Не писать большой static style object inline

---

## 221. Static styles → makeStyles/CSS

---

## 222. Не смешивать 3 styling approaches внутри одного feature без причины

---

# Data attributes

## 223. `data-*` использовать для metadata/testing/integration, не как замену state management

---

## 224. Не хранить business state только в DOM dataset

---

# IDs

## 225. Не создавать DOM id вручную, если он не нужен

---

## 226. Для accessibility IDs использовать `useId`

---

## 227. Domain ID ≠ DOM ID

---

# ARIA

## 228. Не писать ARIA role, который противоречит элементу

---

## 229. `aria-disabled` не заменяет настоящий `disabled`, если элемент поддерживает `disabled`

---

## 230. `aria-hidden` не ставить на focusable element

---

## 231. Hidden content не должен оставаться keyboard focusable

---

# Conditional props

## 232. Не писать много ternary props:

```tsx
<Button
  appearance={a ? "primary" : b ? "secondary" : "subtle"}
/>
```

---

## 233. Если mapping сложный — вычислить до JSX

---

## 234. Простое boolean/2-state ternary inline нормально

---

# React children

## 235. Если wrapper только передаёт children без дополнительной policy — wrapper не нужен

---

## 236. Render props использовать только если это реальная reusable behavior pattern

---

## 237. Не использовать render props там, где обычный composition проще

---

# Conditional wrapper

## 238. Не создавать универсальный `ConditionalWrapper` для каждой мелочи

---

## 239. Часто явный JSX проще

---

# Portals

## 240. Portal использовать только для layer/overlay, где он нужен

---

## 241. Не portal-ить обычный контент

---

## 242. Portal должен соблюдать общий z-index/layer contract

---

# Performance markup

## 243. Не рендерить hidden heavy tree, если его можно не mount

---

## 244. Но если remount дорогой и state должен сохраняться — решить осознанно

---

## 245. `display:none` не является универсальной оптимизацией

---

## 246. Virtualization для больших списков

---

## 247. Не рендерить 10 000 `<SongCard>`

---

## 248. Большой list должен иметь stable dimensions/measurement strategy

---

# Loading media

## 249. Не создавать `<img>` для cover за пределами viewport без lazy strategy, если список большой

---

## 250. Не монтировать все preview video одновременно

---

# Refactor

## 251. При замене JSX implementation удалить старую

---

## 252. Не оставлять:

```text
OldSongCard
NewSongCard
SongCardV2
```

---

## 253. При удалении component удалить его styles/tests/imports

---

## 254. После перехода на Fluent component удалить старый самописный аналог

---

## 255. Не держать два варианта одного dialog после migration

---

# Formatting

## 256. Prettier authority

---

## 257. Не форматировать TSX вручную против Prettier

---

## 258. Props на одной строке, если реально помещаются читаемо

---

## 259. Если props много — переносить, не пытаться ужать всё в одну строку

---

## 260. Закрывающий tag не должен теряться в гигантской вложенности

---

## 261. JSX должен визуально показывать hierarchy

---

# Comments

## 262. Не комментировать:

```tsx
{/* Button */}
<Button />
```

---

## 263. Комментарий только для non-obvious reason

---

## 264. Не хранить old JSX в comments

---

# HTML security

## 265. Не вставлять пользовательский HTML напрямую

---

## 266. `dangerouslySetInnerHTML` запрещён по умолчанию

---

## 267. External links имеют safe handling

---

## 268. Не позволять arbitrary protocol

---

# Data output

## 269. Не отображать raw JSON пользователю, если это не diagnostics

---

## 270. Diagnostic JSON отдельный explicit view

---

# Accessibility text

## 271. Не делать icon единственным способом понять action без label/accessible name

---

## 272. Status color не должен быть единственным способом различить состояние

---

## 273. Добавлять text/icon/semantic signal

---

# Responsive

## 274. Не делать layout, который работает только при одной ширине окна

---

## 275. Использовать min/max constraints осознанно

---

## 276. Не ставить fixed width на всё

---

## 277. Fixed width допустим для понятного element, например sidebar

---

## 278. Text containers должны выдерживать длинный localization string

---

## 279. `min-width: 0` помнить в flex/grid, если нужен ellipsis

---

# Ellipsis

## 280. Ellipsis только если полное значение доступно другим способом при необходимости

---

## 281. Не обрезать критическую ошибку без details

---

# Tables/DataGrid

## 282. Не рендерить actions как text links, если это commands и Button/Menu подходит лучше

---

## 283. Не перегружать row десятком inline buttons

---

## 284. Secondary actions → menu

---

# Song cards

## 285. Card должна иметь один primary action

---

## 286. Остальные действия — secondary menu, если их много

---

## 287. Не дублировать action menu markup по всем card types

---

# Status rendering

## 288. Status badge component переиспользовать, если semantics одинаковая

---

## 289. Но разные domain statuses не смешивать в universal mega-status без смысла

---

# State renderer

## 290. Если один feature регулярно имеет:

```text
loading
empty
error
ready
```

можно иметь небольшой local pattern/component.

---

## 291. Не создавать universal application-wide `AsyncRenderer` с десятками props

---

# JSX data mapping

## 292. Map config должен быть `const` вне component, если он статичен

---

## 293. Не пересоздавать static action definitions каждый render

---

## 294. Но если actions захватывают dynamic callbacks, строить их локально допустимо

---

## 295. Не выносить динамический config наружу через костыли

---

# Conditions before render

## 296. Вычислять понятные booleans:

```ts
const canStart = ...
const hasRecording = ...
```

---

## 297. Не писать гигантское boolean expression прямо в JSX

---

## 298. Но не создавать 20 aliases для очевидных условий

---

# Fluent icons

## 299. Иконку выбирать по смыслу, не по внешней похожести

---

## 300. Не дублировать label и aria-label разными смыслами

---

# HTML entities

## 301. Не использовать `&nbsp;` для spacing

---

## 302. Использовать Unicode character только если он часть content, не layout

---

# CSS classes naming

## 303. Имена по роли:

```text
root
header
content
actions
```

в scoped style module/hook допустимы.

---

## 304. Не использовать:

```text
redBox
leftThing
div2
```

---

# Avoid DOM hacks

## 305. Не искать DOM через `document.querySelector` из feature component, если ref решает задачу

---

## 306. Не искать child по class name для imperative control

---

## 307. Использовать React refs/props

---

## 308. Direct DOM только для реально imperative integration

---

# Focus

## 309. Не вызывать `.focus()` во время render

---

## 310. Focus management через effect/event lifecycle

---

## 311. Не фокусировать element при каждом rerender

---

# Modals

## 312. Modal open state один owner

---

## 313. Не хранить `isModalOpen` в нескольких местах

---

## 314. Не создавать глобальный modal stack без реальной необходимости

---

# Conditional mounting

## 315. Если dialog закрыт, обычно не держать тяжелый content mounted без причины

---

## 316. Но draft state может жить выше dialog, если должен сохраняться

---

# Forms repeated fields

## 317. Повторяющиеся одинаковые fields можно map по typed config

---

## 318. Не генерировать сложные формы целиком из JSON config без необходимости

---

# HTML escaping

## 319. React автоматически escapes text — не обходить это без причины

---

# Component children APIs

## 320. Compound components использовать только для реального reusable composition pattern

---

## 321. Не делать:

```text
<Card.Root>
<Card.Header>
<Card.Body>
<Card.Footer>
```

для одного локального component без reuse.

---

# CSS grid areas

## 322. Grid areas допустимы для сложного стабильного layout

---

## 323. Не использовать их для двух колонок, если обычный grid проще

---

# DOM size

## 324. Следить за количеством DOM nodes на тяжелых screens

---

## 325. Не создавать декоративные wrappers для каждого эффекта

---

## 326. Для визуализатора DOM не должен конкурировать с canvas/WebGL engine

---

# SVG

## 327. Не вставлять огромный inline SVG вручную в каждый component

---

## 328. Использовать icon component/assets

---

## 329. SVG accessibility учитывать

---

# Truncated content

## 330. Tooltip на truncated text только если пользователю нужно полное значение

---

# Data attributes for testing

## 331. Предпочитать semantic selectors

---

## 332. `data-testid` не должен определять production architecture

---

# Re-render friendliness

## 333. Static markup выносить только если это реально уменьшает работу/шум

---

## 334. Не выносить JSX в constant за component, если он зависит от theme/context

---

# Empty fragment

## 335. Не возвращать `<></>` вместо `null`

---

# Boolean props naming

## 336. Писать:

```tsx
<Panel compact />
```

вместо:

```tsx
<Panel isCompact={true} />
```

если API компонента проектируется с нуля и имя однозначно.

---

## 337. Для domain meaning `isReady` может быть яснее, чем `ready`, если это не UI variant

---

# Children order

## 338. Порядок JSX должен соответствовать visual/semantic flow

---

## 339. Не переставлять DOM только CSS `order`, если это ломает keyboard/screen-reader order

---

# Hidden content

## 340. `display:none` / conditional render должен согласовываться с accessibility

---

## 341. Hidden interactive content не должен оставаться focusable

---

# ARIA live

## 342. `aria-live` использовать только для важных динамических сообщений

---

## 343. Не ставить `aria-live` на постоянно меняющиеся audio levels

---

# Progress

## 344. Progress bar имеет accessible value where applicable

---

## 345. Indeterminate progress отличается от determinate

---

# Labels

## 346. Icon + text action не требует дублирования aria-label, если visible text уже даёт имя

---

# Button types

## 347. Внутри form контролировать `type`

---

# Input autocomplete

## 348. Использовать подходящий `autoComplete` where relevant

---

# Drag and drop

## 349. Drop zone должна иметь keyboard/alternative file picker path

---

## 350. Drag-only interaction запрещён

---

# Editor interactions

## 351. Drag note должен иметь альтернативный keyboard/accessibility path там, где это product requirement

---

## 352. Не создавать тысячи отдельные DOM nodes для note visualization, если canvas лучше

---

# Visualizer

## 353. Heavy visualizer render не должен быть JSX tree

---

## 354. React монтирует canvas/container, engine делает frame rendering

---

# Localization markup

## 355. Не строить sentence из нескольких translated fragments в JSX

Плохо:

```tsx
{t("hello")} {name} {t("today")}
```

если порядок слов зависит от языка.

---

## 356. Использовать полноценную translation template/interpolation

---

# Numbers

## 357. User-facing числа форматировать через formatter/Intl

---

## 358. Не писать `%` вручную в 20 местах

---

# Error detail

## 359. Technical details скрывать под Details/Diagnostics, а не выводить огромным pre block всегда

---

# `pre` / code

## 360. `<pre>` только для реально preformatted diagnostic/text content

---

# Lists of actions

## 361. Если action list >3–4, подумать о Menu

---

## 362. Не делать toolbar из 12 одинаковых Buttons, если часть второстепенная

---

# Repeated sections

## 363. Если section одинаковая по layout и semantics — reusable Section component допустим

---

## 364. Если переиспользуется один раз — отдельный component не нужен

---

# HTML attributes

## 365. Не передавать `undefined` attributes вручную

React сам не рендерит их.

---

## 366. Не ставить пустой `title=""`

---

# IDs in loops

## 367. DOM IDs внутри списка должны быть уникальными

---

# Link security

## 368. External links в Electron не открывать обычным browser navigation без policy

---

## 369. Использовать desktop/openExternal bridge

---

# Loading button

## 370. Во время submit button показывает понятный pending state

---

## 371. Не менять layout кнопки резко, если можно сохранить размер

---

# Disabled

## 372. Disabled action должна иметь понятную причину там, где пользователь может не понимать

---

## 373. Tooltip/help text допустим для недоступного action, но не должен заменять нормальный state explanation

---

# Placeholder skeleton

## 374. Skeleton structure должна приблизительно соответствовать content, а не быть случайными полосами

---

# Empty values

## 375. Не показывать `undefined`, `null`, `[object Object]`

---

## 376. Presentation fallback централизован по смыслу

---

# DOM event bubbling

## 377. Не использовать `stopPropagation()` как постоянный костыль

---

## 378. Если card click конфликтует с inner buttons, продумать event boundaries

---

## 379. Inner Button не должен случайно запускать Card primary action

---

# Cards

## 380. Если card целиком interactive, semantics должна быть ясной

---

## 381. Не вкладывать `<button>` в `<button>`

---

## 382. Не делать interactive parent button, если внутри нужны другие interactive controls

---

# Nested interactive elements

## 383. Nested interactive HTML запрещён

Например:

```html
<button>
  <a>
```

---

# Toolbars

## 384. Toolbar semantics where appropriate

---

## 385. Controls grouped logically

---

# Refs

## 386. Ref callback не должен выполнять тяжелую logic

---

# Error Boundary fallback markup

## 387. Fallback должен оставаться минимальным и надёжным

---

## 388. Не использовать сложные feature dependencies внутри global crash fallback

---

# Startup markup

## 389. Startup screen не должен зависеть от тех же systems, failure которых он должен показать

---

# Custom titlebar

## 390. Drag region не накрывает interactive controls

---

## 391. Buttons имеют `-webkit-app-region: no-drag` where required

---

## 392. Window controls на top layer

---

# Fullscreen

## 393. Fullscreen UI не должен дублировать весь screen отдельной implementation

---

## 394. Один component composition адаптируется по mode

---

# CSS vs JSX conditions

## 395. Не делать JS conditional render только ради визуального hide, если element должен оставаться mounted и CSS действительно лучше

---

## 396. Но не скрывать тяжелый unused content CSS-ом, если его можно не рендерить

---

# Feature flags

## 397. Не держать оба JSX дерева после завершения flag rollout

---

## 398. После rollout старую ветку удалить

---

# HTML duplication

## 399. Повторение одной и той же семантической разметки много раз — кандидат на component

---

## 400. Повторение просто похожих div не является достаточной причиной

---

# Keep markup readable

## 401. Не использовать слишком умные generic renderers

---

## 402. Не использовать reflection-like rendering по имени поля без product reason

---

## 403. JSX должен показывать реальную структуру UI, а не скрывать её в config engine

---

# Conditional labels/icons

## 404. Для label/icon по status использовать typed mapping

---

## 405. Для сильно разных components использовать switch/explicit branch

---

# Wrapper components

## 406. Wrapper должен добавлять value

---

## 407. Passthrough wrapper без value удалить

---

# Styling wrappers

## 408. Если wrapper существует только ради одного gap, проверить можно ли gap дать parent

---

# HTML validation

## 409. Не создавать invalid nesting

---

## 410. Следить за button/anchor/form nesting

---

# Forms nested

## 411. Не вкладывать `<form>` в `<form>`

---

# Multiple forms

## 412. Разделять независимые submit flows

---

# Focus trap

## 413. Focus trap только внутри настоящего modal context

---

## 414. Он не должен блокировать titlebar system controls согласно app policy

---

# Tabs content

## 415. Не дублировать tab panels, если можно data-map одинаковый layout

---

## 416. Но разные tab domains могут быть отдельными components

---

# Responsive markup

## 417. Не менять semantic DOM radically только ради breakpoint без необходимости

---

## 418. CSS должен делать большую часть responsive layout

---

# Empty wrappers in maps

## 419. Не писать:

```tsx
items.map(item => (
  <>
    <Row ... />
  </>
))
```

если Fragment ничего не даёт.

---

# Return fragments

## 420. Несколько sibling elements → Fragment

---

## 421. Не добавлять div только потому, что React требует один root — Fragment уже решает

---

# Inline components

## 422. Не объявлять component внутри другого component render, если он пересоздаётся каждый render

---

## 423. Вынести наружу или оставить JSX inline

---

# Render functions

## 424. Маленькая render helper-функция допустима

---

## 425. Но если helper имеет собственный UI concept — component лучше

---

# HTML title attribute

## 426. Не использовать `title` как замену полноценного tooltip/help UX

---

# DataGrid

## 427. Для complex tabular list Fluent DataGrid лучше ручной grid, если подходит

---

# CSS selectors

## 428. Не зависеть от порядкового `:nth-child` для business semantics

---

# DOM order

## 429. Business order должен быть в данных, не CSS trick

---

# Menu items

## 430. Destructive action визуально/семантически отличается согласно design system

---

# Hidden labels

## 431. Visually hidden text допустим для accessibility

---

# Status text

## 432. Не использовать emoji как единственный status indicator

---

# Icons

## 433. Не использовать разные icons для одного action в разных screens без причины

---

# Forms errors

## 434. Общая server error не должна дублироваться под каждым field

---

# Async buttons

## 435. Не оставлять clickable action активным во время неидемпотентной pending mutation

---

# JSX comments

## 436. Комментарий внутри JSX только если объясняет неочевидную структуру

---

# Markup extraction

## 437. Перед extraction спросить: появился ли настоящий reusable concept?

---

# Line count

## 438. Не пытаться уменьшить JSX-файл простым переносом огромного блока в `renderSomething.tsx`, если responsibility не изменилась

---

# Better extraction

## 439. Выделять `ProcessingStatus`, а не `RenderBlock2`

---

# Naming

## 440. Component name — существительное/UI concept

```text
SongCard
ProcessingQueue
RoomParticipant
```

---

## 441. Не:

```text
Component1
Block
Thing
Wrapper2
```

---

# Conditional classes mapping

## 442. Typed mapping for finite variant styles

---

# UI variants

## 443. Variant prop должен быть закрытым union

```ts
type Variant = "default" | "compact";
```

---

## 444. Не использовать arbitrary string для variant

---

# Slots

## 445. Не строить slot API, если component не имеет реального reusable composition need

---

# Content projection

## 446. `children` проще render prop там, где подходит

---

# Final HTML/JSX rule

## 447.

```text
LESS DOM
IS GOOD
ONLY IF
SEMANTICS STAY CORRECT
```

---

## 448.

```text
LESS JSX
IS GOOD
ONLY IF
THE UI STRUCTURE STAYS OBVIOUS
```

---

## 449.

```text
REUSE DATA-DRIVEN REPETITION
DO NOT HIDE UNIQUE BEHAVIOR
IN GENERIC RENDERERS
```

---

## 450.

```text
SEMANTICS
>
SHORTNESS
```

---

## 451.

```text
ACCESSIBILITY
>
VISUAL TRICKS
```

---

## 452.

```text
FLAT MARKUP
>
WRAPPER CHAINS
```

---

## 453.

```text
EXPLICIT JSX
>
CLEVER META-UI
```

---

## 454.

```text
ONE STABLE UI PATTERN
→ ONE REUSABLE COMPONENT

ONE UNIQUE UI CASE
→ KEEP IT EXPLICIT
```

---

# Status

```text
JSX / TSX / HTML CODE STYLE RULES
=
LOCKED
```
# Повторяющаяся разметка: `map` и компоненты

## 1. Если JSX повторяется и отличается только данными — использовать `map`

Плохо:

```tsx
<Button icon={<PlayRegular />} onClick={onPlay}>
  Play
</Button>

<Button icon={<PauseRegular />} onClick={onPause}>
  Pause
</Button>

<Button icon={<StopRegular />} onClick={onStop}>
  Stop
</Button>
```

Хорошо:

```tsx
const actions = [
  { key: "play", label: "Play", icon: <PlayRegular />, onClick: onPlay },
  { key: "pause", label: "Pause", icon: <PauseRegular />, onClick: onPause },
  { key: "stop", label: "Stop", icon: <StopRegular />, onClick: onStop }
];

return actions.map(action => (
  <Button key={action.key} icon={action.icon} onClick={action.onClick}>
    {action.label}
  </Button>
));
```

---

## 2. `map` использовать только если структура одинакова

Если меняются только:

```text
label
icon
value
handler
status
```

это хороший кандидат на `map`.

---

## 3. Если поведение блоков сильно отличается — не прятать всё в `map`

Плохо:

```ts
const items = [
  {
    type: "song",
    render: () => ...
  },
  {
    type: "recording",
    render: () => ...
  },
  {
    type: "room",
    render: () => ...
  }
];
```

если каждый элемент фактически имеет совершенно разную логику.

---

## 4. Повторяющиеся статусы выводить через mapping

Например:

```ts
const statusConfig = {
  ready: {
    label: "Ready",
    icon: <CheckmarkRegular />
  },
  processing: {
    label: "Processing",
    icon: <Spinner />
  },
  failed: {
    label: "Failed",
    icon: <ErrorCircleRegular />
  }
} satisfies Record<SongStatus, StatusConfig>;
```

---

## 5. Не писать одинаковые `if` для status в разных компонентах

Плохо:

```tsx
if (status === "ready") ...
if (status === "processing") ...
if (status === "failed") ...
```

в:

```text
SongCard
SongDetails
ProcessingPanel
SongMenu
```

Если presentation semantics одинаковая — использовать общий mapping/component.

---

## 6. Повторяющийся набор кнопок — через data map

Например toolbar:

```ts
const toolbarItems = [
  { id: "undo", icon: <ArrowUndoRegular />, action: onUndo },
  { id: "redo", icon: <ArrowRedoRegular />, action: onRedo },
  { id: "delete", icon: <DeleteRegular />, action: onDelete }
];
```

---

## 7. Не дублировать одинаковую кнопку 10 раз руками

Если отличается только:

```text
icon
label
callback
disabled
```

использовать data-driven rendering.

---

## 8. Повторяющиеся navigation items — через массив + `map`

```tsx
const items = [
  { value: "library", label: "Library", icon: <LibraryRegular /> },
  { value: "history", label: "History", icon: <HistoryRegular /> },
  { value: "settings", label: "Settings", icon: <SettingsRegular /> }
];
```

---

## 9. Tabs — через typed array

```tsx
const tabs = [
  { value: "general", label: "General" },
  { value: "audio", label: "Audio" },
  { value: "models", label: "Models" }
] as const;
```

---

## 10. Повторяющиеся form fields можно описывать data map

Если поля реально имеют одинаковый шаблон:

```tsx
const fields = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" }
];
```

---

## 11. Но не превращать сложную форму в JSON engine

Если одно поле:

```text
Dropdown
```

второе:

```text
Audio Device Tester
```

третье:

```text
Folder Picker
```

не надо пытаться впихнуть всё в один универсальный renderer.

---

## 12. Если повторяется целый смысловой блок — выносить в компонент

Например повторяется:

```text
icon
title
description
action
```

Создать:

```tsx
<SettingsCard />
```

вместо копирования разметки.

---

## 13. Компонент создаётся, если повторяется не только markup, но и UI-concept

Например:

```text
SongCard
ParticipantCard
SettingRow
StatCard
EmptyState
```

---

## 14. Не создавать компонент только потому, что 4 строки похожи

Если блок используется один раз и не имеет отдельного смысла — оставить inline.

---

## 15. Повторение 2 раза ещё не всегда abstraction

Сначала проверить, действительно ли semantics одинаковая.

---

## 16. Повторение 3+ раз — сильный кандидат на extraction

Особенно если меняются только props/data.

---

## 17. Если повторяется layout, а данные разные — reusable component

Плохо:

```tsx
<div className={styles.card}>
  <Text>CPU</Text>
  <Text>{cpu}</Text>
</div>

<div className={styles.card}>
  <Text>RAM</Text>
  <Text>{ram}</Text>
</div>

<div className={styles.card}>
  <Text>GPU</Text>
  <Text>{gpu}</Text>
</div>
```

Хорошо:

```tsx
const stats = [
  { label: "CPU", value: cpu },
  { label: "RAM", value: ram },
  { label: "GPU", value: gpu }
];

return stats.map(stat => (
  <StatCard key={stat.label} {...stat} />
));
```

---

## 18. Если повторяется только один внутренний фрагмент — можно вынести маленький компонент

Например:

```tsx
<InfoRow label="Sample Rate" value={sampleRate} />
<InfoRow label="Buffer" value={buffer} />
<InfoRow label="Latency" value={latency} />
```

---

## 19. Не копировать одинаковый `label/value` layout руками

---

## 20. Для простых key/value блоков использовать один reusable `InfoRow`

---

## 21. Для repeated menu items — data map

---

## 22. Для repeated radio/select options — data map

---

## 23. Для repeated badges — mapping

---

## 24. Для repeated setting sections — reusable section component

---

## 25. Для repeated confirmation dialogs — shared dialog pattern только если semantics одинаковая

---

## 26. Не делать universal dialog со 30 props

Лучше:

```text
ConfirmDialog
DeleteSongDialog
```

если behavior реально различается.

---

## 27. `map` не должен содержать 50 строк JSX

Если item renderer большой:

```tsx
items.map(item => <SongCard ... />)
```

лучше, чем giant inline callback.

---

## 28. Если callback в `.map()` стал большим — вынести item component

---

## 29. `.map()` должен быть легко читаемым

Хорошо:

```tsx
{songs.map(song => (
  <SongCard key={song.id} song={song} />
))}
```

---

## 30. Плохо

```tsx
{songs.map(song => {
  const canPlay = ...
  const canDelete = ...
  const status = ...
  const actions = ...
  return (
    // 60 строк JSX
  );
})}
```

---

## 31. Большой renderer item = отдельный component

---

## 32. Логику item не считать внутри `.map()`, если её можно инкапсулировать

---

## 33. Но не создавать `SongCardContainer` + `SongCardView` без необходимости

Один нормальный `SongCard` лучше лишних слоёв.

---

## 34. Данные для map должны быть typed

Плохо:

```ts
const actions = [
  { type: "x", data: ... }
];
```

без понятного type.

---

## 35. Для закрытого списка использовать `as const`

---

## 36. Для полного mapping union использовать `satisfies`

```ts
const config = {
  ready: ...,
  failed: ...
} satisfies Record<SongStatus, StatusConfig>;
```

---

## 37. Это позволяет TypeScript проверить, что состояние не забыто

---

## 38. Не использовать `Object.entries` с потерей типов без необходимости

Если keys закрыты — typed mapping/helper может быть лучше.

---

## 39. Data map хранить вне component, если он статичен

---

## 40. Не пересоздавать статический массив при каждом render

Плохо:

```tsx
const actions = [
  { label: "A" },
  { label: "B" }
];
```

в component, если он вообще не зависит от props/state.

---

## 41. Статические config вынести на module level

---

## 42. Динамический config оставлять внутри component, если он зависит от текущего state

---

## 43. Не выносить наружу dynamic config через странные фабрики только ради «оптимизации»

---

# Когда `map`, когда компонент

## 44. Использовать `map`, если:

```text
одинаковая структура
+
разные данные
```

---

## 45. Использовать component, если:

```text
повторяется самостоятельный UI concept
+
есть собственные props/behavior/layout
```

---

## 46. Использовать и `map`, и component вместе, если:

```text
есть список одинаковых UI concepts
```

Пример:

```tsx
{participants.map(participant => (
  <ParticipantCard
    key={participant.id}
    participant={participant}
  />
))}
```

---

## 47. Не писать повторяющийся `ParticipantCard` вручную

---

## 48. Не делать giant `map` вместо `ParticipantCard`

---

# Универсальное правило выбора

## 49.

```text
ПОВТОРЯЕТСЯ ТОЛЬКО ДАННЫЕ
→ MAP

ПОВТОРЯЕТСЯ UI-КОНЦЕПТ
→ COMPONENT

ПОВТОРЯЕТСЯ UI-КОНЦЕПТ СПИСКОМ
→ MAP + COMPONENT

ПОВТОРЯЕТСЯ ПОВЕДЕНИЕ
→ HOOK / FUNCTION

ПОВТОРЯЕТСЯ DOMAIN-ПРАВИЛО
→ ОДНА CANONICAL LOGIC
```

---

## 50. Не использовать один инструмент для всех видов повторения

---

## 51. Не сокращать код так, чтобы исчезал смысл

---

## 52. Цель — не меньше строк любой ценой

Цель:

```text
меньше дублирования
+
меньше мест для ошибки
+
понятнее структура
```

---

# Главное правило

```text
ЕСЛИ БЛОКИ ОДИНАКОВЫЕ
И ОТЛИЧАЮТСЯ ТОЛЬКО ДАННЫМИ
→ ОПИСАТЬ ДАННЫЕ ОДИН РАЗ
И ВЫВЕСТИ ЧЕРЕЗ MAP
```

```text
ЕСЛИ ОДИНАКОВЫЙ БЛОК
ИМЕЕТ САМОСТОЯТЕЛЬНЫЙ СМЫСЛ
→ ВЫНЕСТИ ЕГО В COMPONENT
```

```text
ЕСЛИ ЭТО СПИСОК ТАКИХ БЛОКОВ
→ MAP + COMPONENT
```
