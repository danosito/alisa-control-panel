import { h } from "../../ui/dom";
import type { WidgetDefinition } from "../types";

type Config = { uptime: boolean; temp: boolean; wifi: boolean; disk: boolean; load: boolean; net: boolean };

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400), hrs = Math.floor((seconds % 86400) / 3600), min = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} д ${hrs} ч`;
  if (hrs > 0) return `${hrs} ч ${min} мин`;
  return `${min} мин`;
}
const rate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Мбит/с` : `${Math.round(kbps)} кбит/с`);

interface Item { key: keyof Config; label: string; el: HTMLElement; value: HTMLElement; bar: HTMLElement }

// System facts of the speaker: uptime, SoC temperature, Wi-Fi, free flash,
// load average and network throughput.
export const systemWidget: WidgetDefinition<Config> = {
  id: "system",
  title: "Система",
  description: "Аптайм, температура, Wi-Fi, свободное место, нагрузка и сеть",
  category: "Система",
  sizes: [{ w: 24, h: 16 }, { w: 16, h: 16 }, { w: 32, h: 4 }, { w: 8, h: 24 }, { w: 16, h: 8 }],
  minSize: { w: 6, h: 2 },
  maxSize: { w: 48, h: 40 },
  aspect: [0.25, 16],
  defaultConfig: { uptime: true, temp: true, wifi: true, disk: true, load: true, net: true },
  configSchema: [
    { key: "uptime", label: "Аптайм", type: "checkbox" },
    { key: "temp", label: "Температура SoC", type: "checkbox" },
    { key: "wifi", label: "Wi-Fi", type: "checkbox" },
    { key: "disk", label: "Свободно на /bkupgrade", type: "checkbox" },
    { key: "load", label: "Нагрузка (load average)", type: "checkbox" },
    { key: "net", label: "Сеть", type: "checkbox" },
  ],
  sync: () => ({ kind: "dashboard", intervalMs: 2000 }),
  mount(host) {
    const make = (key: keyof Config, label: string): Item => {
      const value = h("strong", { class: "w-sys__value" }, "—");
      const bar = h("span", { class: "w-sys__bar" });
      const el = h("div", { class: "w-sys__item", "data-key": key }, h("span", { class: "w-sys__label" }, label), value, h("span", { class: "w-sys__track" }, bar));
      return { key, label, el, value, bar };
    };
    const items = [make("temp", "Температура"), make("wifi", "Wi-Fi"), make("disk", "Флеш"), make("uptime", "Аптайм"), make("load", "Нагрузка"), make("net", "Сеть")];
    const grid = h("div", { class: "w-sys__grid" }, items.map((i) => i.el));
    const line = h("div", { class: "w-sys__line" });
    const root = h("div", { class: "w w-sys" }, grid, line);
    host.append(root);
    return {
      update({ data, config, tier }) {
        root.dataset.tier = tier;
        const s = data.system, m = data.metrics;
        const parts: string[] = [];
        for (const item of items) {
          item.el.hidden = !config[item.key];
          let text = "—", fraction: number | null = null, tone = "";
          if (s) {
            if (item.key === "temp") { text = `${s.temp_c.toFixed(0)} °C`; fraction = (s.temp_c - 30) / 55; tone = s.temp_c > 75 ? "hot" : s.temp_c > 62 ? "warm" : ""; }
            if (item.key === "wifi") { text = `${s.wifi_quality}% · ${s.wifi_rssi} дБм`; fraction = s.wifi_quality / 100; tone = s.wifi_quality < 35 ? "hot" : ""; }
            if (item.key === "disk") { text = `${s.disk_free_mb} / ${s.disk_total_mb} МБ`; fraction = s.disk_total_mb ? 1 - s.disk_free_mb / s.disk_total_mb : null; tone = s.disk_free_mb < 10 ? "hot" : s.disk_free_mb < 20 ? "warm" : ""; }
            if (item.key === "uptime") text = uptime(s.uptime_s);
            if (item.key === "load") { text = s.load.map((l) => l.toFixed(2)).join(" · "); fraction = s.load[0] / 4; tone = s.load[0] > 3.5 ? "hot" : ""; }
          }
          if (item.key === "net" && m) text = `↓ ${rate(m.net_rx_kbps)}  ↑ ${rate(m.net_tx_kbps)}`;
          item.value.textContent = text;
          item.el.dataset.tone = tone;
          item.bar.parentElement!.hidden = fraction === null;
          if (fraction !== null) item.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
          if (config[item.key] && text !== "—") parts.push(item.key === "net" ? text : `${item.label.toLowerCase()} ${text}`);
        }
        line.textContent = parts.join("  ·  ");
      },
    };
  },
};
