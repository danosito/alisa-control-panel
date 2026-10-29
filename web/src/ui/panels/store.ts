import { WORKSPACE_KEY } from "../../api/storage";
import type { GridSize, WidgetConfig } from "../../widgets/types";

export interface Placement { x: number; y: number; w: number; h: number }
export interface WidgetInstance {
  id: string;
  widgetId: string;
  /** Desktop (64-column) placement. */
  desktop: Placement;
  /** Narrow-screen (16-column) placement, once the user has arranged it there. */
  mobile?: Placement;
  config: WidgetConfig;
}
export interface Panel { id: string; title: string; widgets: WidgetInstance[] }
export interface WorkspaceState { version: 2; activePanelId: string; panels: Panel[] }

const STORAGE_KEY = WORKSPACE_KEY;
/** Widgets that no longer exist; dropped on load. */
const REMOVED_WIDGETS = new Set(["sound-test"]);
const REMOVED_PANELS = new Set(["testing"]);
const uid = () => (crypto.randomUUID?.() ?? `w${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const place = (widgetId: string, x: number, y: number, w: number, h: number, config: WidgetConfig = {}): WidgetInstance => ({ id: uid(), widgetId, desktop: { x, y, w, h }, config });

function homePanel(): Panel {
  return { id: "home", title: "Главная", widgets: [
    place("image", 0, 0, 16, 16),
    place("player", 16, 0, 32, 16),
    place("clock", 48, 0, 16, 8),
    place("text", 48, 8, 16, 8, { text: "Всё под\nконтролем", style: "heading", frame: true }),
    place("led", 0, 16, 16, 16),
    place("bluetooth", 16, 16, 16, 16),
    place("terminal", 32, 16, 16, 16),
    place("metrics", 48, 16, 16, 16),
  ] };
}

function monitoringPanel(): Panel {
  return { id: "monitoring", title: "Мониторинг", widgets: [
    place("metrics", 0, 0, 40, 16, { temp: true }),
    place("system", 40, 0, 24, 16),
    place("terminal", 0, 16, 40, 28, { command: "btop" }),
    place("microphone", 40, 16, 24, 12),
    place("bluetooth", 40, 28, 24, 16),
  ] };
}

function musicPanel(): Panel {
  return { id: "music", title: "Музыка", widgets: [
    place("player", 0, 0, 28, 28),
    place("visualizer", 28, 0, 36, 16, { mode: "bars", scheme: "accent" }),
    place("visualizer", 28, 16, 28, 12, { mode: "wave", scheme: "led" }),
    place("volume", 56, 16, 8, 12),
    place("led", 0, 28, 24, 16),
    place("visualizer", 24, 28, 24, 16, { mode: "circle", scheme: "rainbow" }),
    place("clock", 48, 28, 8, 16),
    place("microphone", 56, 28, 8, 16),
  ] };
}

function defaults(): WorkspaceState {
  return { version: 2, activePanelId: "home", panels: [homePanel(), monitoringPanel(), musicPanel()] };
}

/** Keeps the user's screens, removes retired widgets/screens, adds new screens. */
function migrate(state: WorkspaceState): WorkspaceState {
  state.panels = state.panels.filter((p) => !REMOVED_PANELS.has(p.id));
  for (const panel of state.panels) panel.widgets = panel.widgets.filter((w) => !REMOVED_WIDGETS.has(w.widgetId));
  for (const make of [monitoringPanel, musicPanel]) {
    const panel = make();
    if (!state.panels.some((p) => p.id === panel.id)) state.panels.push(panel);
  }
  if (!state.panels.length) return defaults();
  if (!state.panels.some((p) => p.id === state.activePanelId)) state.activePanelId = state.panels[0]!.id;
  return state;
}

function valid(value: unknown): value is WorkspaceState {
  const v = value as WorkspaceState | null;
  return Boolean(v && v.version === 2 && Array.isArray(v.panels) && v.panels.length > 0 && v.panels.every((p) => typeof p.id === "string" && Array.isArray(p.widgets)));
}

export class PanelStore {
  private value: WorkspaceState;
  private listeners = new Set<() => void>();

  constructor() {
    const read = (key: string): unknown => { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } };
    const current = read(STORAGE_KEY);
    this.value = valid(current) ? migrate(current) : defaults();
    this.save();
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get state(): WorkspaceState { return this.value; }
  panel(id: string): Panel | undefined { return this.value.panels.find((p) => p.id === id); }
  active(): Panel { return this.panel(this.value.activePanelId) ?? this.value.panels[0]!; }
  widget(panelId: string, instanceId: string): WidgetInstance | undefined { return this.panel(panelId)?.widgets.find((w) => w.id === instanceId); }

  /** Persist without notifying (used for high-frequency layout writes). */
  save(): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value)); }
  private commit(): void { this.save(); this.listeners.forEach((l) => l()); }

  setActive(id: string): void { if (this.panel(id) && this.value.activePanelId !== id) { this.value.activePanelId = id; this.save(); } }
  addPanel(title = "Новый экран"): Panel { const panel: Panel = { id: uid(), title, widgets: [] }; this.value.panels.push(panel); this.value.activePanelId = panel.id; this.commit(); return panel; }
  renamePanel(id: string, title: string): void { const p = this.panel(id); if (p && title.trim() && p.title !== title.trim()) { p.title = title.trim(); this.commit(); } }
  removePanel(id: string): void {
    if (this.value.panels.length <= 1) return;
    const index = this.value.panels.findIndex((p) => p.id === id);
    this.value.panels.splice(index, 1);
    if (this.value.activePanelId === id) this.value.activePanelId = this.value.panels[Math.max(0, index - 1)]!.id;
    this.commit();
  }
  movePanel(id: string, delta: -1 | 1): void {
    const i = this.value.panels.findIndex((p) => p.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= this.value.panels.length) return;
    const [panel] = this.value.panels.splice(i, 1); this.value.panels.splice(j, 0, panel!); this.commit();
  }

  addWidget(panelId: string, widgetId: string, at: Placement, config: WidgetConfig = {}): WidgetInstance {
    const instance: WidgetInstance = { id: uid(), widgetId, desktop: at, config };
    this.panel(panelId)?.widgets.push(instance); this.save();
    return instance;
  }
  removeWidget(panelId: string, instanceId: string): void { const p = this.panel(panelId); if (p) { p.widgets = p.widgets.filter((w) => w.id !== instanceId); this.save(); } }
  setConfig(panelId: string, instanceId: string, config: WidgetConfig): void { const w = this.widget(panelId, instanceId); if (w) { w.config = config; this.save(); } }
  setPlacement(panelId: string, instanceId: string, columns: number, placement: Placement): void {
    const w = this.widget(panelId, instanceId); if (!w) return;
    if (columns >= 64) w.desktop = placement; else w.mobile = placement;
  }
  resetLayout(): void { this.value = defaults(); this.commit(); }
}

export function sizeOf(p: Placement): GridSize { return { w: p.w, h: p.h }; }
