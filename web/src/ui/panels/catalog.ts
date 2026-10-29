import { GridStack } from "gridstack";
import { fixtureApi, fixtureData, fixtureLive } from "../../widgets/fixtures";
import { WidgetHost } from "../../widgets/host";
import { listWidgets } from "../../widgets/registry";
import { h } from "../dom";

const PREVIEW_CELL = 9; // px per grid unit inside the preview (scaled down later)
const CARD_W = 168, CARD_H = 104;

/** Horizontal, scrollable widget strip shown in edit mode. */
export function createCatalog(onAdd: (widgetId: string) => void): { el: HTMLElement; open(): void; close(): void } {
  const el = h("div", { class: "catalog", "aria-label": "Виджеты" });
  let hosts: WidgetHost[] = [];
  let dragArmed = false;
  const api = fixtureApi();
  const data = fixtureData();
  const live = fixtureLive();

  function open(): void {
    close();
    const cards = listWidgets().map((definition) => {
      const size = definition.sizes[0]!;
      const natural = { width: size.w * PREVIEW_CELL * 2.2, height: size.h * PREVIEW_CELL * 2.2 };
      const scale = Math.min(CARD_W / natural.width, CARD_H / natural.height, 1);
      const host = new WidgetHost({ api, live, widgetId: definition.id, config: {}, size, data, preview: true });
      hosts.push(host);
      const stage = h("div", { class: "catalog-card__stage", style: `width:${natural.width}px;height:${natural.height}px;transform:scale(${scale})` }, host.el);
      return h("div", { class: "catalog-card", "data-widget-id": definition.id, "gs-w": size.w, "gs-h": size.h, title: `${definition.title} — перетащите на экран или нажмите`, onclick: () => { if (!dragArmed) onAdd(definition.id); } },
        h("div", { class: "catalog-card__preview" }, stage),
        h("div", { class: "catalog-card__meta" }, h("strong", {}, definition.title), h("span", {}, `${size.w}×${size.h} · ${definition.category}`)),
      );
    });
    el.replaceChildren(...cards);
    GridStack.setupDragIn(cards, { appendTo: "body", helper: "clone", start: () => { dragArmed = true; }, stop: () => { window.setTimeout(() => { dragArmed = false; }, 0); } });
  }
  function close(): void { for (const host of hosts) host.destroy(); hosts = []; el.replaceChildren(); }
  // Vertical wheel scrolls the strip horizontally (Shift+wheel and trackpads work natively).
  el.addEventListener("wheel", (event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { el.scrollLeft += event.deltaY; event.preventDefault(); } }, { passive: false });
  return { el, open, close };
}
