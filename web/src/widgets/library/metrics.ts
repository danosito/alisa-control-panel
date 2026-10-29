import uPlot from "uplot";
import { h } from "../../ui/dom";
import type { Metrics } from "../../api/types";
import type { WidgetContext, WidgetDefinition } from "../types";

type Config = { cpu: boolean; ram: boolean; temp: boolean; net: boolean; chart: boolean; window: string; refresh: string; stats: boolean };

const CPU = "#c084fc";
const RAM = "#67e8f9";
const TEMP = "#fb923c";
const NET = "#4ade80";
const rate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Мбит/с` : `${Math.round(kbps)} кбит/с`);

const ramPercent = (m: Metrics) => (m.ram_total_mb ? (m.ram_used_mb * 100) / m.ram_total_mb : 0);

function stat(label: string, color: string): { el: HTMLElement; value: HTMLElement; sub: HTMLElement } {
  const value = h("strong", { class: "w-metrics__value" }, "—");
  const sub = h("span", { class: "w-metrics__sub" });
  const el = h("div", { class: "w-metrics__stat", style: `--accent:${color}` }, h("span", { class: "w-metrics__label" }, label), value, sub);
  return { el, value, sub };
}

function summary(values: number[]): string {
  if (!values.length) return "";
  const min = Math.min(...values), max = Math.max(...values), avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `мин ${min.toFixed(0)} · ср ${avg.toFixed(0)} · макс ${max.toFixed(0)}`;
}

export const metricsWidget: WidgetDefinition<Config> = {
  id: "metrics",
  title: "Ресурсы",
  description: "CPU, RAM, температура и сеть с историей",
  category: "Система",
  sizes: [{ w: 32, h: 16 }, { w: 16, h: 8 }, { w: 16, h: 16 }, { w: 32, h: 32 }, { w: 16, h: 4 }, { w: 8, h: 20 }],
  minSize: { w: 4, h: 2 },
  maxSize: { w: 64, h: 48 },
  aspect: [0.3, 16],
  defaultConfig: { cpu: true, ram: true, temp: false, net: false, chart: true, window: "120", refresh: "1000", stats: true },
  configSchema: [
    { key: "cpu", label: "CPU", type: "checkbox" },
    { key: "ram", label: "RAM", type: "checkbox" },
    { key: "temp", label: "Температура (линия и плитка)", type: "checkbox" },
    { key: "net", label: "Сеть (плитка)", type: "checkbox" },
    { key: "chart", label: "График", type: "checkbox" },
    { key: "stats", label: "Мин/среднее/макс (крупные размеры)", type: "checkbox" },
    { key: "window", label: "Окно истории", type: "select", options: [{ value: "30", label: "30 секунд" }, { value: "60", label: "1 минута" }, { value: "120", label: "2 минуты" }] },
    { key: "refresh", label: "Обновление", type: "select", options: [{ value: "1000", label: "1 с" }, { value: "2000", label: "2 с" }, { value: "5000", label: "5 с" }] },
  ],
  sync: (config) => ({ kind: "dashboard", intervalMs: Number(config.refresh) || 1000 }),
  mount(host) {
    const cpu = stat("CPU", CPU);
    const ram = stat("RAM", RAM);
    const temp = stat("TEMP", TEMP);
    const net = stat("NET", NET);
    const inline = h("div", { class: "w-metrics__inline" });
    const stats = h("div", { class: "w-metrics__stats" }, cpu.el, ram.el, temp.el, net.el);
    const chartHost = h("div", { class: "w-metrics__chart" });
    const root = h("div", { class: "w w-metrics" }, inline, stats, chartHost);
    host.append(root);
    let plot: uPlot | null = null;
    let last: WidgetContext<Config> | null = null;

    const series = (config: Config): uPlot.Series[] => [
      {},
      { label: "CPU", stroke: CPU, width: 2, fill: "rgba(192,132,252,.12)", show: config.cpu },
      { label: "RAM", stroke: RAM, width: 2, show: config.ram },
      { label: "°C", stroke: TEMP, width: 1.5, dash: [4, 3], show: config.temp },
    ];
    const ensurePlot = () => {
      const { width, height } = chartHost.getBoundingClientRect();
      if (!last || width < 20 || height < 20) return;
      if (plot) { plot.setSize({ width: Math.floor(width), height: Math.floor(height) }); return; }
      const axis = { stroke: "#687383", grid: { stroke: "#1c222b", width: 1 }, ticks: { show: false }, font: "10px ui-monospace, monospace" };
      plot = new uPlot({
        width: Math.floor(width), height: Math.floor(height),
        legend: { show: false }, cursor: { show: false }, select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        scales: { x: { time: false }, y: { range: [0, 100] } },
        axes: [{ ...axis, show: false }, { ...axis, size: 34, splits: () => [0, 25, 50, 75, 100], values: (_u, ticks) => ticks.map((t) => (last?.config.temp ? `${t}` : `${t}%`)) }],
        series: series(last.config),
      }, [[], [], [], []], chartHost);
      render();
    };
    const render = () => {
      if (!last) return;
      const { data, config } = last;
      const window = Number(config.window) || 120;
      const points = data.history.slice(-window);
      if (plot) {
        const xs = points.map((_, i) => i - points.length + 1);
        plot.setData([xs, points.map((p) => p.cpu_percent), points.map(ramPercent), points.map((p) => p.temp_c ?? 0)]);
      }
      const m = data.metrics;
      cpu.value.textContent = m ? `${m.cpu_percent.toFixed(0)}%` : "—";
      ram.value.textContent = m ? `${ramPercent(m).toFixed(0)}%` : "—";
      ram.sub.textContent = m ? `${m.ram_used_mb} / ${m.ram_total_mb} MB` : "";
      temp.value.textContent = m ? `${(m.temp_c ?? 0).toFixed(0)}°` : "—";
      temp.sub.textContent = "SoC";
      net.value.textContent = m ? rate((m.net_rx_kbps ?? 0) + (m.net_tx_kbps ?? 0)) : "—";
      net.sub.textContent = m ? `↓ ${rate(m.net_rx_kbps ?? 0)} ↑ ${rate(m.net_tx_kbps ?? 0)}` : "";
      const showStats = config.stats && (last.tier === "large" || last.tier === "tall");
      cpu.sub.textContent = showStats ? summary(points.map((p) => p.cpu_percent)) : "";
      if (showStats) ram.sub.textContent += ` · ${summary(points.map(ramPercent))}`;
      inline.replaceChildren(
        ...(config.cpu && m ? [h("span", { style: `color:${CPU}` }, `CPU ${m.cpu_percent.toFixed(0)}%`)] : []),
        ...(config.ram && m ? [h("span", { style: `color:${RAM}` }, `RAM ${ramPercent(m).toFixed(0)}%`)] : []),
        ...(config.temp && m ? [h("span", { style: `color:${TEMP}` }, `${(m.temp_c ?? 0).toFixed(0)}°C`)] : []),
      );
    };
    const observer = new ResizeObserver(() => ensurePlot());
    observer.observe(chartHost);

    return {
      update(ctx) {
        const configChanged = !last || JSON.stringify(last.config) !== JSON.stringify(ctx.config);
        last = ctx;
        root.dataset.tier = ctx.tier;
        cpu.el.hidden = !ctx.config.cpu;
        ram.el.hidden = !ctx.config.ram;
        temp.el.hidden = !ctx.config.temp;
        net.el.hidden = !ctx.config.net;
        const chartVisible = ctx.config.chart && ctx.tier !== "tiny" && ctx.tier !== "compact" && (ctx.tier !== "slim" || ctx.size.h >= 24);
        chartHost.hidden = !chartVisible;
        if (configChanged && plot) { plot.destroy(); plot = null; }
        if (chartVisible) ensurePlot();
        render();
      },
      destroy() { observer.disconnect(); plot?.destroy(); },
    };
  },
};
