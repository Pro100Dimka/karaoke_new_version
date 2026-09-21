# Frontend — универсальные правила JSX / TSX / HTML

**Stack**

```text
React
TypeScript
TSX
Fluent UI
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

# Fluent UI

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