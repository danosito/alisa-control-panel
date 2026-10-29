# Как написать виджет

Виджет — один модуль в `web/src/widgets/library/` плюс одна строка регистрации.
Каталог, настройки, сохранение раскладки, ресайз с пропорциями, выгрузка невидимых
экранов, превью в каталоге и виджет-кит подхватывают его автоматически.

## Минимальный пример

`web/src/widgets/library/uptime.ts`:

```ts
import { h } from "../../ui/dom";
import type { WidgetDefinition } from "../types";

type Config = { label: string; seconds: boolean };

export const uptimeWidget: WidgetDefinition<Config> = {
  id: "uptime",                       // стабильный id: хранится в раскладках пользователей
  title: "Аптайм",
  description: "Сколько станция работает без перезагрузки",
  category: "Система",
  sizes: [{ w: 16, h: 6 }, { w: 8, h: 4 }, { w: 6, h: 16 }], // пресеты; первый — по умолчанию
  minSize: { w: 4, h: 2 },
  maxSize: { w: 32, h: 16 },
  aspect: [0.2, 10],                  // допустимое отношение ширины к высоте
  defaultConfig: { label: "Аптайм", seconds: false },
  configSchema: [                     // из этого строится диалог настроек
    { key: "label", label: "Подпись", type: "text" },
    { key: "seconds", label: "С секундами", type: "checkbox" },
  ],
  sync: () => ({ kind: "dashboard", intervalMs: 5000 }), // как часто нужны данные сервера
  mount(host) {
    const label = h("span", { class: "w-muted" });
    const value = h("strong", { class: "w-uptime__value" });
    host.append(h("div", { class: "w w-uptime" }, label, value));
    return {
      update({ data, config, tier }) {
        const s = data.system?.uptime_s ?? 0;
        const hms = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
        label.textContent = config.label;
        label.hidden = tier === "tiny";
        value.textContent = hms.slice(0, config.seconds ? 3 : 2).map((n) => String(n).padStart(2, "0")).join(":");
      },
    };
  },
};
```

Регистрация в `web/src/widgets/library/index.ts` — импорт и элемент списка
(порядок списка = порядок в каталоге):

```ts
import { uptimeWidget } from "./uptime";
// …
for (const widget of [playerWidget, /* … */, uptimeWidget]) registerWidget(widget);
```

Стили — в `web/src/styles/widgets.css`, с префиксом своего класса:

```css
.w-uptime { justify-content: center; }
.w-uptime__value { font: 700 clamp(1rem, min(40cqh, 20cqw), 4rem) var(--font-mono); }
```

`.w` — общая карточка (фон, рамка, отступы, flex-колонка). Хост виджета — container
query container, поэтому размеры удобно задавать в `cqw`/`cqh`/`cqmin`.

## Контракт

`mount(host, ctx)` вызывается один раз и возвращает `{ update(ctx), destroy?() }`.
`update` вызывается сразу после монтирования и при каждом изменении данных, размера
или настроек — рендерьте идемпотентно. В `destroy` снимайте таймеры, наблюдатели,
подписки.

| Поле `ctx` | Что это |
|---|---|
| `data` | снимок `/api/v1/dashboard`: `state`, `metrics`, `history`, `devices`, `media`, `system`, `capabilities` |
| `config` | настройки экземпляра (`defaultConfig` + сохранённые пользователем) |
| `size`, `tier`, `orientation` | размер в клетках сетки, класс размера и ориентация |
| `api` | клиент REST (`ledMode`, `media`, `volumeSet`, `get`/`post` для своих ручек) |
| `live` | поток реального времени: `ctx.live.subscribe({ playback, mic, media }, { frame, media, status })` возвращает функцию отписки |
| `preview` | `true` в каталоге и виджет-ките: `api`/`live` подменены, железо не трогать |
| `refresh()` | попросить немедленную синхронизацию (после действия) |

**Классы размера (`tier`).** Рисуйте разные варианты, а не просто масштабируйте:
`tiny` — строка (h < 8), `slim` — узкая колонка (w < 10, высота ≥ 2×ширины),
`compact` — меньше стандартной плитки, `regular` — 16×16, `wide` — ~32×16,
`tall` — ~16×32, `large` — 32×32 и больше.

**Синхронизация.** `sync(config)` возвращает `{ kind: "none" }` для чисто клиентских
виджетов или `{ kind: "dashboard", intervalMs }`. Приложение опрашивает один общий
`/api/v1/dashboard` с минимальным интервалом среди смонтированных виджетов; экраны
дальше соседних выгружаются и данных не требуют.

**Реальное время.** Кадр анализатора (`LiveFrame`) приходит 30 раз в секунду:
`bands` (48 полос, 0..1), `wave`, `level`, `bass`/`mid`/`treble`, `beat`, `micDb`.
Захват звука на станции идёт, только пока на него кто-то подписан.

## Помощники

- `ui/dom.ts`: `h(tag, attrs, ...children)` — создание DOM без фреймворка; `svgIcon`.
- `widgets/canvas.ts`: `createSurface` (canvas с учётом DPR и ресайза),
  `animationLoop` (rAF, который спит, когда виджет не виден), `schemeColor`,
  `resample` (48 полос → N столбиков).

## Проверка: виджет-кит

```sh
cd web
npm run kit                       # → web/dist/kit.html
open "dist/kit.html?widget=uptime"
open 'dist/kit.html?widget=visualizer&config={"mode":"circle"}'
```

Кит рендерит виджет во всех пресетах и типовых размерах (включая узкие колонки)
на фейковых данных, теми же `WidgetHost`, что и прод. `npm run check` — проверка типов.

## Если нужны новые данные с сервера

- Немного данных для всех: добавьте поле в `DashboardSnapshot` (`src/core.zig`),
  заполните его в обработчике `/api/v1/dashboard` (`src/http.zig`) и в `DataSnapshot`
  (`web/src/api/types.ts`, `web/src/app/app.ts`).
- Своё действие или большие данные: отдельная ручка в `handle()` (`src/http.zig`;
  `requireAuth` для всего, что меняет состояние) и метод в `web/src/api/client.ts`
  или вызов `ctx.api.post(path, body)`.
