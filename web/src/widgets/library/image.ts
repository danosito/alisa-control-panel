import { h } from "../../ui/dom";
import type { WidgetDefinition } from "../types";

type Config = { src: string; fit: string; caption: string; frame: boolean };

export const imageWidget: WidgetDefinition<Config> = {
  id: "image",
  title: "Картинка",
  description: "Изображение по URL; по умолчанию — /assets/logo.png со станции",
  category: "Оформление",
  sizes: [{ w: 16, h: 16 }, { w: 8, h: 8 }, { w: 32, h: 32 }, { w: 32, h: 16 }],
  minSize: { w: 2, h: 2 },
  maxSize: { w: 64, h: 64 },
  aspect: [0.2, 5],
  defaultConfig: { src: "/assets/logo.png", fit: "contain", caption: "", frame: true },
  configSchema: [
    { key: "src", label: "Адрес изображения", type: "text", placeholder: "/assets/logo.png или https://…" },
    { key: "fit", label: "Масштаб", type: "select", options: [{ value: "contain", label: "Целиком" }, { value: "cover", label: "Заполнить" }] },
    { key: "caption", label: "Подпись", type: "text" },
    { key: "frame", label: "Рамка и фон", type: "checkbox" },
  ],
  sync: () => ({ kind: "none" }),
  mount(host) {
    const img = h("img", { class: "w-image__img", alt: "", decoding: "async", draggable: "false" }) as HTMLImageElement;
    const caption = h("figcaption", { class: "w-image__caption" });
    const empty = h("p", { class: "w-muted w-image__empty", hidden: true }, "Нет изображения: положите файл в assets/logo.png на станции или укажите адрес в настройках виджета");
    const root = h("figure", { class: "w w-image" }, img, empty, caption);
    host.append(root);
    img.addEventListener("error", () => { img.hidden = true; empty.hidden = false; });
    img.addEventListener("load", () => {
      img.hidden = false; empty.hidden = true;
      try {
        const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
        const c = canvas.getContext("2d", { willReadFrequently: true }); if (!c) return;
        c.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
        const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
        root.style.setProperty("--image-bg", a! > 200 ? `rgb(${r} ${g} ${b})` : "transparent");
      } catch { /* cross-origin image: keep the default background */ }
    });
    return {
      update({ config, tier }) {
        if (img.getAttribute("src") !== config.src) img.src = config.src;
        img.alt = config.caption || "Изображение";
        img.style.objectFit = config.fit;
        root.classList.toggle("w--frameless", !config.frame);
        caption.textContent = config.caption;
        caption.hidden = !config.caption || tier === "tiny" || tier === "compact";
      },
    };
  },
};
