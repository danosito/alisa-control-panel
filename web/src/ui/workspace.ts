import type { ApiClient } from "../api/client";
import type { LiveClient } from "../api/live";
import type { DataSnapshot } from "../widgets/types";
import { findWidget } from "../widgets/registry";
import { h, svgIcon } from "./dom";
import { createCatalog } from "./panels/catalog";
import { PanelView } from "./panels/panelView";
import { openWidgetSettings } from "./panels/settingsDialog";
import { PanelStore } from "./panels/store";

export interface Workspace {
  el: HTMLElement;
  /** Called by the app whenever /dashboard delivered new data. */
  setData(data: DataSnapshot): void;
  /** Polling interval the visible widgets need, or null when nothing needs the server. */
  syncIntervalMs(): number | null;
  destroy(): void;
}

const EDIT_ICON = '<path d="m4 20 4.2-1 9.9-9.9a2.1 2.1 0 0 0-3-3L5.2 16z"/><path d="m13.5 7.5 3 3"/>';
const USER_ICON = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
const LONG_PRESS_MS = 550;

export function createWorkspace(api: ApiClient, live: LiveClient, options: { onLogout: () => void; onRefresh: () => void; owner?: string }): Workspace {
  const store = new PanelStore();
  let data: DataSnapshot = { capabilities: null, state: null, metrics: null, history: [], devices: [], media: null, system: null };
  let editing = false;
  const views = new Map<string, PanelView>();

  const strip = h("div", { class: "screens" });
  const tabs = h("nav", { class: "topbar__tabs", "aria-label": "Экраны" });
  const catalog = createCatalog((widgetId) => activeView()?.addWidget(widgetId));
  const addScreen = h("button", { class: "topbar__chip", type: "button", onclick: () => { const panel = store.addPanel(); buildViews(); scrollTo(panel.id, false); } }, "+ экран");
  const editButton = h("button", { class: "topbar__icon", type: "button", "aria-label": "Редактировать", title: "Редактировать (долгое нажатие)", onclick: () => setEditing(!editing) }, svgIcon(EDIT_ICON));
  const profileMenu = h("div", { class: "topbar__menu", hidden: true }, h("span", { class: "topbar__owner" }, options.owner ?? "Владелец"),
    h("button", { type: "button", class: "w-btn", onclick: () => { if (confirm("Вернуть экраны и виджеты к раскладке по умолчанию?")) { store.resetLayout(); for (const view of views.values()) view.destroy(); views.clear(); buildViews(); scrollTo(store.active().id, false); } } }, "Сбросить раскладку"),
    h("button", { type: "button", class: "w-btn", onclick: options.onLogout }, "Выйти"));
  const profile = h("div", { class: "topbar__profile" }, h("button", { class: "topbar__icon", type: "button", "aria-label": "Профиль", onclick: () => { profileMenu.hidden = !profileMenu.hidden; } }, svgIcon(USER_ICON)), profileMenu);
  const left = h("div", { class: "topbar__left" }, tabs);
  const topbar = h("header", { class: "topbar" }, left, h("div", { class: "topbar__right" }, editButton, profile));
  const el = h("main", { class: "home", id: "main" }, topbar, strip);

  const activeView = () => views.get(store.active().id);

  function buildViews(): void {
    const ids = new Set(store.state.panels.map((p) => p.id));
    for (const [id, view] of views) if (!ids.has(id)) { view.destroy(); views.delete(id); }
    for (const panel of store.state.panels) {
      if (views.has(panel.id)) continue;
      const view = new PanelView({ store, panelId: panel.id, api, live, data: () => data, refresh: options.onRefresh, onConfigure: configure, onLayoutChange: () => undefined });
      views.set(panel.id, view);
    }
    // Keep DOM order identical to the store order, then let GridStack measure.
    strip.replaceChildren(...store.state.panels.map((p) => views.get(p.id)!.el));
    for (const view of views.values()) { view.init(); view.setEditing(editing); }
    renderTabs();
    updateMounts();
  }

  function renderTabs(): void {
    const activeId = store.active().id;
    tabs.replaceChildren(...store.state.panels.map((panel, index) => {
      const tab = h("button", { class: `topbar__tab ${panel.id === activeId ? "topbar__tab--active" : ""}`, type: "button", role: "tab", "aria-selected": String(panel.id === activeId), onclick: () => scrollTo(panel.id, true) }, panel.title);
      if (!editing) return tab;
      const title = h("input", { class: "topbar__rename", value: panel.title, "aria-label": "Название экрана", size: Math.max(6, panel.title.length) }) as HTMLInputElement;
      title.addEventListener("change", () => { store.renamePanel(panel.id, title.value); renderTabs(); });
      title.addEventListener("focus", () => scrollTo(panel.id, true));
      return h("span", { class: `topbar__tab topbar__tab--edit ${panel.id === activeId ? "topbar__tab--active" : ""}` },
        h("button", { type: "button", class: "topbar__mini", title: "Левее", disabled: index === 0, onclick: () => { store.movePanel(panel.id, -1); buildViews(); } }, "‹"),
        title,
        h("button", { type: "button", class: "topbar__mini", title: "Правее", disabled: index === store.state.panels.length - 1, onclick: () => { store.movePanel(panel.id, 1); buildViews(); } }, "›"),
        store.state.panels.length > 1 ? h("button", { type: "button", class: "topbar__mini topbar__mini--danger", title: "Удалить экран", onclick: () => { if (confirm(`Удалить экран «${panel.title}»?`)) { store.removePanel(panel.id); buildViews(); } } }, "✕") : null,
      );
    }));
  }

  /** Active and adjacent screens are live; everything else is off-loaded. */
  function updateMounts(): void {
    const panels = store.state.panels;
    const index = Math.max(0, panels.findIndex((p) => p.id === store.active().id));
    panels.forEach((panel, i) => { const view = views.get(panel.id)!; if (Math.abs(i - index) <= 1) view.mount(); else view.unmount(); });
    for (const view of views.values()) if (view.isMounted) view.pushData(data);
  }

  function scrollTo(panelId: string, smooth: boolean): void {
    const index = store.state.panels.findIndex((p) => p.id === panelId);
    if (index < 0) return;
    strip.scrollTo({ left: index * strip.clientWidth, behavior: smooth ? "smooth" : "auto" });
    setActive(panelId);
  }
  function setActive(panelId: string): void {
    if (store.active().id === panelId) return;
    store.setActive(panelId); renderTabs(); updateMounts(); options.onRefresh();
  }
  let scrollTimer: number | undefined;
  strip.addEventListener("scroll", () => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      const index = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
      const panel = store.state.panels[index];
      if (panel) setActive(panel.id);
    }, 90);
  }, { passive: true });

  function setEditing(next: boolean): void {
    if (editing === next) return;
    editing = next;
    el.classList.toggle("home--editing", editing);
    editButton.classList.toggle("topbar__icon--active", editing);
    editButton.replaceChildren(editing ? h("span", { class: "topbar__done" }, "Готово") : svgIcon(EDIT_ICON));
    for (const view of views.values()) view.setEditing(editing);
    if (editing) { left.replaceChildren(tabs, addScreen); el.insertBefore(catalog.el, strip); catalog.open(); }
    else { catalog.close(); catalog.el.remove(); left.replaceChildren(tabs); }
    renderTabs();
  }

  async function configure(panelId: string, instanceId: string): Promise<void> {
    const view = views.get(panelId); const instance = view?.instance(instanceId);
    const definition = instance ? findWidget(instance.widgetId) : undefined;
    if (!view || !instance || !definition) return;
    const result = await openWidgetSettings(definition, instance.config, view.currentSize(instanceId) ?? instance.desktop);
    if (result) view.configure(instanceId, result.config, result.size);
  }

  // Long press anywhere on a screen (mouse, trackpad or touch) enters edit mode.
  let pressTimer: number | undefined; let pressOrigin: { x: number; y: number } | null = null;
  const cancelPress = () => { window.clearTimeout(pressTimer); pressOrigin = null; };
  strip.addEventListener("pointerdown", (event) => {
    if (editing || event.button !== 0) return;
    pressOrigin = { x: event.clientX, y: event.clientY };
    pressTimer = window.setTimeout(() => { pressOrigin = null; navigator.vibrate?.(12); setEditing(true); }, LONG_PRESS_MS);
  });
  strip.addEventListener("pointermove", (event) => { if (pressOrigin && Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > 8) cancelPress(); });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) strip.addEventListener(type, cancelPress);
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && editing && !document.querySelector("dialog[open]")) setEditing(false); };
  document.addEventListener("keydown", onKey);
  const onResize = () => scrollTo(store.active().id, false);
  window.addEventListener("resize", onResize);

  // Build after insertion so GridStack can measure real widths.
  queueMicrotask(() => { buildViews(); scrollTo(store.active().id, false); });

  return {
    el,
    setData(next) { data = next; for (const view of views.values()) if (view.isMounted) view.pushData(data); },
    syncIntervalMs() {
      const panels = store.state.panels;
      const index = panels.findIndex((p) => p.id === store.active().id);
      let best: number | null = null;
      for (const panel of panels.slice(Math.max(0, index - 1), index + 2)) {
        const ms = views.get(panel.id)?.syncIntervalMs() ?? null;
        if (ms !== null && (best === null || ms < best)) best = ms;
      }
      return best;
    },
    destroy() { document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onResize); catalog.close(); for (const view of views.values()) view.destroy(); },
  };
}
