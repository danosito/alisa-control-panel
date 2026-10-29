import { h } from "../../ui/dom";
import type { WidgetDefinition } from "../types";

type Config = { seconds: boolean; date: boolean; frame: boolean; layout: string };

// Font size is bounded by both width and height (container query units, see
// widgets.css) so the time never overflows. Narrow columns stack HH over MM.
export const clockWidget: WidgetDefinition<Config> = {
  id: "clock",
  title: "Часы",
  description: "Время и дата, работает без сервера; есть вертикальный вариант",
  category: "Инструменты",
  sizes: [{ w: 16, h: 8 }, { w: 8, h: 4 }, { w: 16, h: 16 }, { w: 32, h: 16 }, { w: 6, h: 16 }],
  minSize: { w: 3, h: 2 },
  maxSize: { w: 64, h: 32 },
  aspect: [0.15, 12],
  defaultConfig: { seconds: false, date: true, frame: true, layout: "auto" },
  configSchema: [
    { key: "seconds", label: "Секунды", type: "checkbox" },
    { key: "date", label: "Дата", type: "checkbox" },
    { key: "layout", label: "Раскладка", type: "select", options: [{ value: "auto", label: "Авто" }, { value: "line", label: "В строку" }, { value: "stack", label: "Столбиком" }] },
    { key: "frame", label: "Карточка", type: "checkbox" },
  ],
  sync: () => ({ kind: "none" }),
  mount(host, initial) {
    const hours = h("span", { class: "w-clock__part" });
    const minutes = h("span", { class: "w-clock__part" });
    const seconds = h("span", { class: "w-clock__part w-clock__part--sec" });
    const sep1 = h("span", { class: "w-clock__sep" }, ":");
    const sep2 = h("span", { class: "w-clock__sep w-clock__part--sec" }, ":");
    const time = h("div", { class: "w-clock__time" }, hours, sep1, minutes, sep2, seconds);
    const date = h("div", { class: "w-clock__date" });
    const root = h("div", { class: "w w-clock" }, time, date);
    host.append(root);
    let ctx = initial;
    const tick = () => {
      const now = new Date();
      const two = (n: number) => String(n).padStart(2, "0");
      hours.textContent = two(now.getHours());
      minutes.textContent = two(now.getMinutes());
      seconds.textContent = two(now.getSeconds());
      const stack = root.dataset.layout === "stack";
      date.textContent = now.toLocaleDateString("ru-RU", stack ? { weekday: "short", day: "numeric", month: "short" } : { weekday: "long", day: "numeric", month: "long" });
    };
    const timer = window.setInterval(tick, 1000);
    return {
      update(next) {
        ctx = next;
        const stack = next.config.layout === "stack" || (next.config.layout === "auto" && (next.tier === "slim" || next.size.h > next.size.w * 1.3));
        root.dataset.layout = stack ? "stack" : "line";
        root.dataset.seconds = next.config.seconds ? "1" : "0";
        date.hidden = !next.config.date || (next.tier === "tiny" && !stack);
        root.dataset.tier = next.tier;
        root.classList.toggle("w--frameless", !next.config.frame);
        void ctx;
        tick();
      },
      destroy() { window.clearInterval(timer); },
    };
  },
};
