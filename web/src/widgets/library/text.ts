import { h } from "../../ui/dom";
import type { WidgetDefinition } from "../types";

type Config = { text: string; style: string; align: string; frame: boolean; direction: string };

// Font size follows the widget size through container query units (see
// widgets.css), so the same text works as a 2×8 label and as a 32×16 heading.
export const textWidget: WidgetDefinition<Config> = {
  id: "text",
  title: "Текст",
  description: "Заголовок, подпись или заметка",
  category: "Оформление",
  sizes: [{ w: 16, h: 4 }, { w: 8, h: 2 }, { w: 32, h: 6 }, { w: 16, h: 16 }, { w: 4, h: 20 }],
  minSize: { w: 2, h: 1 },
  maxSize: { w: 64, h: 48 },
  aspect: [0.05, 48],
  defaultConfig: { text: "Заголовок", style: "heading", align: "left", frame: false, direction: "auto" },
  configSchema: [
    { key: "text", label: "Текст", type: "textarea" },
    { key: "style", label: "Стиль", type: "select", options: [
      { value: "heading", label: "Заголовок" }, { value: "body", label: "Текст" }, { value: "label", label: "Подпись" }, { value: "mono", label: "Моноширинный" },
    ] },
    { key: "align", label: "Выравнивание", type: "select", options: [{ value: "left", label: "Слева" }, { value: "center", label: "По центру" }, { value: "right", label: "Справа" }] },
    { key: "direction", label: "Направление", type: "select", options: [{ value: "auto", label: "Авто (узкий столбик — вертикально)" }, { value: "horizontal", label: "Горизонтально" }, { value: "vertical", label: "Вертикально" }] },
    { key: "frame", label: "Карточка", type: "checkbox" },
  ],
  sync: () => ({ kind: "none" }),
  mount(host) {
    const body = h("div", { class: "w-text__body" });
    const root = h("div", { class: "w w-text" }, body);
    host.append(root);
    return {
      update({ config, tier, size }) {
        body.textContent = config.text;
        const vertical = config.direction === "vertical" || (config.direction === "auto" && size.h >= size.w * 2.5 && size.w <= 8);
        root.dataset.vertical = vertical ? "1" : "0";
        root.dataset.style = config.style;
        root.dataset.tier = tier;
        root.style.textAlign = config.align;
        root.classList.toggle("w--frameless", !config.frame);
      },
    };
  },
};
