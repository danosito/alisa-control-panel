import { GridStack, type GridItemHTMLElement, type GridStackNode } from "gridstack";
import type { ApiClient } from "../../api/client";
import type { LiveClient } from "../../api/live";
import { WidgetHost } from "../../widgets/host";
import { findWidget } from "../../widgets/registry";
import { constrainSize, type DataSnapshot } from "../../widgets/types";
import { h } from "../dom";
import type { PanelStore, Placement, WidgetInstance } from "./store";

export const DESKTOP_COLUMNS = 64;
export const MOBILE_COLUMNS = 16;

interface Item { instance: WidgetInstance; el: GridItemHTMLElement; content: HTMLElement; host: WidgetHost | null }

export interface PanelViewOptions {
  store: PanelStore;
  panelId: string;
  api: ApiClient;
  live: LiveClient;
  data: () => DataSnapshot;
  refresh: () => void;
  onConfigure: (panelId: string, instanceId: string) => void;
  onLayoutChange: () => void;
}

/** One screen: a GridStack grid whose widgets can be mounted or off-loaded. */
export class PanelView {
  readonly el: HTMLElement;
  private readonly gridRoot: HTMLElement;
  private grid: GridStack | null = null;
  private items = new Map<string, Item>();
  private mounted = false;
  private editing = false;
  private dragging = false;

  constructor(private readonly options: PanelViewOptions) {
    this.gridRoot = h("div", { class: "grid-stack" });
    this.el = h("section", { class: "panel", "data-panel": options.panelId }, this.gridRoot);
  }

  get panelId(): string { return this.options.panelId; }

  /** Must be called once the element is in the DOM so GridStack can measure it. */
  init(): void {
    if (this.grid) return;
    this.grid = GridStack.init({
      column: DESKTOP_COLUMNS,
      cellHeight: "auto",
      margin: 5,
      float: true,
      animate: true,
      staticGrid: true,
      acceptWidgets: ".catalog-card",
      resizable: { handles: "se, e, s" },
      // The edit overlay is the drag handle: widgets stay non-interactive while editing.
      handle: ".widget-edit",
      draggable: { handle: ".widget-edit", cancel: ".widget-edit__actions button" },
      // columnMax defaults to 12 in GridStack; without it the 64-column grid collapses.
      columnOpts: { columnMax: DESKTOP_COLUMNS, breakpoints: [{ w: 760, c: MOBILE_COLUMNS, layout: "list" }, { w: 100000, c: DESKTOP_COLUMNS }] },
    }, this.gridRoot);
    const panel = this.options.store.panel(this.panelId);
    this.grid.batchUpdate();
    for (const instance of panel?.widgets ?? []) this.addItem(instance);
    this.grid.batchUpdate(false);
    this.applyMobileLayout();
    this.grid.on("dragstart", () => { this.dragging = true; });
    this.grid.on("dragstop", () => { window.setTimeout(() => { this.dragging = false; }, 0); });
    this.grid.on("change", (_e, nodes: GridStackNode[]) => this.persist(nodes));
    this.grid.on("resizestop", (_e, el) => this.onResized(el as GridItemHTMLElement));
    this.grid.on("dropped", (_e, _prev, node) => this.onDropped(node));
  }

  private itemFor(el: HTMLElement): Item | undefined { return this.items.get(el.getAttribute("gs-id") ?? ""); }

  /** Snaps a freshly resized widget back into its allowed proportions. */
  private onResized(el: GridItemHTMLElement): void {
    const item = this.itemFor(el); const node = el.gridstackNode;
    if (!item || !node || !this.grid) return;
    const definition = findWidget(item.instance.widgetId);
    const current = { w: node.w ?? 1, h: node.h ?? 1 };
    const fixed = definition ? constrainSize(definition, current, this.grid.getColumn()) : current;
    if (fixed.w !== current.w || fixed.h !== current.h) { this.grid.update(el, fixed); this.persistOne(item); return; }
    item.host?.setSize(current);
  }

  private placementFor(instance: WidgetInstance): Placement {
    return this.grid && this.grid.getColumn() < DESKTOP_COLUMNS && instance.mobile ? instance.mobile : instance.desktop;
  }

  private addItem(instance: WidgetInstance): Item {
    const p = instance.desktop;
    const definition = findWidget(instance.widgetId);
    const content = h("div", { class: "grid-stack-item-content" });
    const edit = h("div", { class: "widget-edit" },
      h("span", { class: "widget-edit__name" }, definition?.title ?? instance.widgetId),
      h("span", { class: "widget-edit__actions" },
        h("button", { type: "button", title: "Настроить", "aria-label": "Настроить", onclick: () => this.options.onConfigure(this.panelId, instance.id) }, "⚙"),
        h("button", { type: "button", title: "Удалить", "aria-label": "Удалить", onclick: () => this.removeItem(instance.id) }, "✕"),
      ),
    );
    edit.addEventListener("click", (event) => { if (event.target === edit && !this.dragging) this.options.onConfigure(this.panelId, instance.id); });
    const el = h("div", { class: "grid-stack-item", "gs-id": instance.id, "gs-x": p.x, "gs-y": p.y, "gs-w": p.w, "gs-h": p.h,
      "gs-min-w": definition?.minSize.w ?? 2, "gs-min-h": definition?.minSize.h ?? 2, "gs-max-w": definition?.maxSize.w ?? 64, "gs-max-h": definition?.maxSize.h ?? 64 }, content, edit) as GridItemHTMLElement;
    const item: Item = { instance, el, content, host: null };
    this.items.set(instance.id, item);
    this.grid!.makeWidget(el);
    if (this.mounted) this.mountItem(item);
    return item;
  }

  private mountItem(item: Item): void {
    if (item.host) return;
    const node = item.el.gridstackNode;
    item.host = new WidgetHost({ api: this.options.api, live: this.options.live, widgetId: item.instance.widgetId, config: item.instance.config, size: { w: node?.w ?? item.instance.desktop.w, h: node?.h ?? item.instance.desktop.h }, data: this.options.data(), refresh: this.options.refresh });
    item.content.append(item.host.el);
  }

  private applyMobileLayout(): void {
    if (!this.grid || this.grid.getColumn() >= DESKTOP_COLUMNS) return;
    this.grid.batchUpdate();
    for (const item of this.items.values()) if (item.instance.mobile) this.grid.update(item.el, item.instance.mobile);
    this.grid.batchUpdate(false);
  }

  private persist(nodes: GridStackNode[]): void {
    if (!this.editing || !this.grid) return;
    const columns = this.grid.getColumn();
    for (const node of nodes) {
      const id = String(node.id ?? node.el?.getAttribute("gs-id") ?? "");
      const item = this.items.get(id); if (!item) continue;
      const placement = { x: node.x ?? 0, y: node.y ?? 0, w: node.w ?? 1, h: node.h ?? 1 };
      this.options.store.setPlacement(this.panelId, id, columns, placement);
      item.host?.setSize({ w: placement.w, h: placement.h });
    }
    this.options.store.save();
    this.options.onLayoutChange();
  }

  private onDropped(node: GridStackNode): void {
    const widgetId = node.el?.getAttribute("data-widget-id");
    if (node.el) this.grid?.removeWidget(node.el, true, false);
    const definition = widgetId ? findWidget(widgetId) : undefined;
    if (!definition) return;
    const size = definition.sizes[0]!;
    this.addWidget(definition.id, { x: node.x ?? 0, y: node.y ?? 0, w: size.w, h: size.h });
  }

  /** Adds a widget at `at`, or at the first free spot when omitted. */
  addWidget(widgetId: string, at?: Placement): void {
    const definition = findWidget(widgetId); if (!definition || !this.grid) return;
    const size = definition.sizes[0]!;
    const free = at ?? this.firstFree(size.w, size.h);
    const instance = this.options.store.addWidget(this.panelId, widgetId, free, {});
    const item = this.addItem(instance);
    item.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    this.options.onLayoutChange();
  }

  private firstFree(w: number, h: number): Placement {
    const columns = this.grid!.getColumn();
    for (let y = 0; y < 400; y++) for (let x = 0; x + Math.min(w, columns) <= columns; x++) {
      if (this.grid!.isAreaEmpty(x, y, Math.min(w, columns), h)) return { x, y, w: Math.min(w, columns), h };
    }
    return { x: 0, y: 0, w, h };
  }

  removeItem(instanceId: string): void {
    const item = this.items.get(instanceId); if (!item) return;
    item.host?.destroy();
    this.grid?.removeWidget(item.el, true, false);
    this.items.delete(instanceId);
    this.options.store.removeWidget(this.panelId, instanceId);
    this.options.onLayoutChange();
  }

  configure(instanceId: string, config: Record<string, string | number | boolean>, size?: { w: number; h: number }): void {
    const item = this.items.get(instanceId); if (!item) return;
    item.instance.config = config;
    this.options.store.setConfig(this.panelId, instanceId, config);
    item.host?.setConfig(config);
    const definition = findWidget(item.instance.widgetId);
    if (size && this.grid) { this.grid.update(item.el, definition ? constrainSize(definition, size, this.grid.getColumn()) : size); this.persistOne(item); }
    this.options.onLayoutChange();
  }

  private persistOne(item: Item): void {
    const n = item.el.gridstackNode; if (!n || !this.grid) return;
    const placement = { x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 1, h: n.h ?? 1 };
    this.options.store.setPlacement(this.panelId, item.instance.id, this.grid.getColumn(), placement);
    this.options.store.save();
    item.host?.setSize({ w: placement.w, h: placement.h });
  }

  instance(instanceId: string): WidgetInstance | undefined { return this.items.get(instanceId)?.instance; }
  currentSize(instanceId: string): { w: number; h: number } | undefined { const n = this.items.get(instanceId)?.el.gridstackNode; return n ? { w: n.w ?? 1, h: n.h ?? 1 } : undefined; }

  setEditing(editing: boolean): void {
    this.editing = editing;
    this.grid?.setStatic(!editing);
    this.el.classList.toggle("panel--editing", editing);
  }

  /** Mount widget hosts (visible or adjacent panel). */
  mount(): void { if (this.mounted) return; this.mounted = true; for (const item of this.items.values()) this.mountItem(item); this.el.classList.remove("panel--offloaded"); }
  /** Destroy widget hosts but keep the layout (far-away panel). */
  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const item of this.items.values()) { item.host?.destroy(); item.host = null; }
    this.el.classList.add("panel--offloaded");
  }
  get isMounted(): boolean { return this.mounted; }

  pushData(data: DataSnapshot): void { for (const item of this.items.values()) item.host?.setData(data); }

  /** Smallest polling interval requested by the mounted widgets, or null. */
  syncIntervalMs(): number | null {
    let best: number | null = null;
    for (const item of this.items.values()) { const ms = item.host?.syncIntervalMs() ?? null; if (ms !== null && (best === null || ms < best)) best = ms; }
    return best;
  }

  destroy(): void { this.unmount(); this.grid?.destroy(false); this.el.remove(); }
}
