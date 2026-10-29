// Widget SDK. A widget is a self-contained module: it declares its sizes,
// proportions, configuration schema and data needs, and mounts into a host.
// Adding a widget = one file under widgets/library + one line in library/index.ts.
import type { ApiClient } from "../api/client";
import type { LiveClient } from "../api/live";
import type { BluetoothDevice, Capabilities, PanelState, MediaState, Metrics, SystemInfo } from "../api/types";

/** Size in grid units. The grid has 64 columns on desktop; a cell is square. */
export interface GridSize { w: number; h: number }

/**
 * Coarse layout class derived from the grid size. Widgets render a different
 * variant per tier instead of just shrinking.
 *  tiny    – a strip: h < 8, or small in both directions
 *  slim    – a narrow column: w < 10 and at least twice as tall as wide
 *  compact – smaller than a standard tile
 *  regular – the standard 16×16 tile
 *  wide    – 32×16-ish
 *  tall    – 16×32-ish
 *  large   – 32×32 and up
 */
export type SizeTier = "tiny" | "slim" | "compact" | "regular" | "wide" | "tall" | "large";
export type Orientation = "portrait" | "landscape" | "square";

export function tierOf(size: GridSize): SizeTier {
  if (size.w < 10 && size.h >= 2 * size.w && size.h >= 10) return "slim";
  if (size.h < 8 || (size.w < 8 && size.h < 16)) return "tiny";
  if (size.w < 16 || size.h < 16) return "compact";
  const wide = size.w >= 28, tall = size.h >= 28;
  if (wide && tall) return "large";
  if (wide) return "wide";
  if (tall) return "tall";
  return "regular";
}

export function orientationOf(size: GridSize): Orientation {
  if (size.h > size.w * 1.25) return "portrait";
  if (size.w > size.h * 1.25) return "landscape";
  return "square";
}

/** Clamps a size into the widget's min/max and allowed proportions (w / h). */
export function constrainSize(definition: Pick<WidgetDefinition, "minSize" | "maxSize" | "aspect">, size: GridSize, columns = 64): GridSize {
  let { w, h } = size;
  const [minRatio, maxRatio] = definition.aspect;
  if (w / h < minRatio) h = Math.max(1, Math.floor(w / minRatio));
  if (w / h > maxRatio) w = Math.max(1, Math.floor(h * maxRatio));
  w = Math.min(Math.max(w, definition.minSize.w), definition.maxSize.w, columns);
  h = Math.min(Math.max(h, definition.minSize.h), definition.maxSize.h);
  // Min sizes can push the ratio out again; prefer growing the short side.
  if (w / h < minRatio) w = Math.min(Math.ceil(h * minRatio), definition.maxSize.w, columns);
  if (w / h > maxRatio) h = Math.min(Math.ceil(w / maxRatio), definition.maxSize.h);
  return { w, h };
}

/** What a widget needs from the backend while it is mounted. */
export type SyncNeed =
  | { kind: "none" }
  | { kind: "dashboard"; intervalMs: number };

export type ConfigField =
  | { key: string; label: string; type: "text"; placeholder?: string }
  | { key: string; label: string; type: "textarea"; placeholder?: string }
  | { key: string; label: string; type: "number"; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: "checkbox" }
  | { key: string; label: string; type: "select"; options: Array<{ value: string; label: string }> };

export type WidgetConfig = Record<string, string | number | boolean>;

export interface DataSnapshot {
  capabilities: Capabilities | null;
  state: PanelState | null;
  metrics: Metrics | null;
  history: Metrics[];
  devices: BluetoothDevice[];
  media: MediaState | null;
  system: SystemInfo | null;
}

export interface WidgetContext<C extends WidgetConfig = WidgetConfig> {
  api: ApiClient;
  /** Real-time stream (audio analyser, media events). Fake in previews. */
  live: LiveClient;
  data: DataSnapshot;
  config: C;
  size: GridSize;
  tier: SizeTier;
  orientation: Orientation;
  /** Catalog previews and the widget kit: never open sockets or mutate hardware. */
  preview: boolean;
  /** Ask the host to re-sync now (e.g. after a Bluetooth action). */
  refresh(): void;
}

export interface WidgetHandle<C extends WidgetConfig = WidgetConfig> {
  /** New data and/or new size/config. Called after mount and on every change. */
  update(ctx: WidgetContext<C>): void;
  destroy?(): void;
}

export interface WidgetDefinition<C extends WidgetConfig = WidgetConfig> {
  id: string;
  title: string;
  description: string;
  category: "Система" | "Железо" | "Инструменты" | "Оформление" | "Музыка";
  /** Size presets offered in the catalog and in settings. The first is the default. */
  sizes: GridSize[];
  minSize: GridSize;
  maxSize: GridSize;
  /** Allowed proportions as [min, max] of width / height. */
  aspect: [number, number];
  defaultConfig: C;
  configSchema: ConfigField[];
  sync(config: C): SyncNeed;
  mount(host: HTMLElement, ctx: WidgetContext<C>): WidgetHandle<C>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWidget = WidgetDefinition<any>;
