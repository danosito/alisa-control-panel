import type { ApiClient } from "../api/client";
import type { LiveClient } from "../api/live";
import { h } from "../ui/dom";
import { findWidget } from "./registry";
import { orientationOf, tierOf, type AnyWidget, type DataSnapshot, type GridSize, type WidgetConfig, type WidgetContext, type WidgetHandle } from "./types";

export interface HostOptions {
  api: ApiClient;
  live: LiveClient;
  widgetId: string;
  config: WidgetConfig;
  size: GridSize;
  data: DataSnapshot;
  preview?: boolean;
  refresh?: () => void;
}

/** Mounts one widget instance and keeps its context (data, size, config) current. */
export class WidgetHost {
  readonly el: HTMLElement;
  readonly definition: AnyWidget | undefined;
  private handle: WidgetHandle | null = null;
  private ctx: WidgetContext;

  constructor(options: HostOptions) {
    this.definition = findWidget(options.widgetId);
    this.el = h("div", { class: "widget-host", "data-widget": options.widgetId });
    this.ctx = {
      api: options.api,
      live: options.live,
      data: options.data,
      config: { ...(this.definition?.defaultConfig ?? {}), ...options.config },
      size: options.size,
      tier: tierOf(options.size),
      orientation: orientationOf(options.size),
      preview: options.preview ?? false,
      refresh: options.refresh ?? (() => undefined),
    };
    this.el.dataset.tier = this.ctx.tier;
    this.el.dataset.orientation = this.ctx.orientation;
    if (!this.definition) {
      this.el.append(h("div", { class: "w w-missing" }, `Неизвестный виджет: ${options.widgetId}`));
      return;
    }
    try {
      this.handle = this.definition.mount(this.el, this.ctx);
      this.handle.update(this.ctx);
    } catch (error) {
      this.el.replaceChildren(h("div", { class: "w w-missing" }, `Ошибка виджета ${this.definition.title}: ${String(error)}`));
    }
  }

  get config(): WidgetConfig { return this.ctx.config; }

  setData(data: DataSnapshot): void { this.ctx = { ...this.ctx, data }; this.push(); }
  setSize(size: GridSize): void { this.ctx = { ...this.ctx, size, tier: tierOf(size), orientation: orientationOf(size) }; this.el.dataset.orientation = this.ctx.orientation; this.el.dataset.tier = this.ctx.tier; this.push(); }
  setConfig(config: WidgetConfig): void { this.ctx = { ...this.ctx, config: { ...(this.definition?.defaultConfig ?? {}), ...config } }; this.push(); }

  syncIntervalMs(): number | null {
    if (!this.definition) return null;
    const need = this.definition.sync(this.ctx.config);
    return need.kind === "dashboard" ? need.intervalMs : null;
  }

  destroy(): void { try { this.handle?.destroy?.(); } finally { this.handle = null; this.el.remove(); } }

  private push(): void { try { this.handle?.update(this.ctx); } catch (error) { console.error("widget update failed", this.definition?.id, error); } }
}
