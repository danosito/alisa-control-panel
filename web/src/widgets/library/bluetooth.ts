import { h } from "../../ui/dom";
import type { BluetoothDevice } from "../../api/types";
import type { WidgetContext, WidgetDefinition } from "../types";

type Config = { actions: boolean; forget: boolean; onlyConnected: boolean; pairing: boolean };

export const bluetoothWidget: WidgetDefinition<Config> = {
  id: "bluetooth",
  title: "Bluetooth",
  description: "Сопряжение, подключение и устройства",
  category: "Железо",
  sizes: [{ w: 16, h: 16 }, { w: 32, h: 16 }, { w: 16, h: 8 }, { w: 16, h: 4 }],
  minSize: { w: 6, h: 2 },
  maxSize: { w: 48, h: 48 },
  aspect: [0.5, 12],
  defaultConfig: { actions: true, forget: true, onlyConnected: false, pairing: true },
  configSchema: [
    { key: "pairing", label: "Кнопка pairing", type: "checkbox" },
    { key: "actions", label: "Подключение/отключение", type: "checkbox" },
    { key: "forget", label: "Кнопка «Забыть»", type: "checkbox" },
    { key: "onlyConnected", label: "Только подключённые", type: "checkbox" },
  ],
  sync: () => ({ kind: "dashboard", intervalMs: 3000 }),
  mount(host, initial) {
    let ctx: WidgetContext<Config> = initial;
    const busy = new Set<string>();
    const status = h("span", { class: "w-bt__status" });
    const pairButton = h("button", { class: "w-btn", type: "button" }) as HTMLButtonElement;
    const list = h("div", { class: "w-bt__list" });
    const root = h("div", { class: "w w-bt" }, h("header", { class: "w-head" }, h("strong", { class: "w-head__title" }, "Bluetooth"), pairButton), status, list);
    host.append(root);

    const run = async (key: string, action: () => Promise<unknown>) => {
      if (ctx.preview || busy.has(key)) return;
      busy.add(key); render();
      try { await action(); } catch { /* state is re-read below */ }
      busy.delete(key); ctx.refresh(); render();
    };
    pairButton.addEventListener("click", () => {
      const pairing = ctx.data.state?.bluetooth.pairing ?? false;
      void run("pairing", () => ctx.api.bluetoothAction(pairing ? "pairing/stop" : "pairing/start"));
    });

    const deviceRow = (device: BluetoothDevice) => {
      const compactButtons = ctx.tier === "regular" || ctx.tier === "tall" || ctx.tier === "compact";
      const label = (full: string, short: string) => (compactButtons ? short : full);
      const connect = h("button", { class: "w-btn w-btn--small", type: "button", disabled: busy.has(device.address), title: device.connected ? "Отключить" : "Подключить", onclick: () => void run(device.address, () => ctx.api.bluetoothDeviceAction(device.connected ? "disconnect" : "connect", device.address)) }, busy.has(device.address) ? "…" : device.connected ? label("Отключить", "Откл.") : label("Подключить", "Подкл."));
      const forget = h("button", { class: "w-btn w-btn--small w-btn--danger", type: "button", title: "Забыть устройство", onclick: () => { if (confirm(`Забыть ${device.name || device.address}?`)) void run(device.address, () => ctx.api.bluetoothDeviceAction("remove", device.address)); } }, label("Забыть", "✕"));
      return h("div", { class: `w-bt__device ${device.connected ? "w-bt__device--on" : ""}` },
        h("span", { class: "w-bt__dot" }),
        h("span", { class: "w-bt__name" }, h("strong", {}, device.name || device.address), h("small", {}, device.connected ? "подключено" : "сопряжено")),
        ctx.config.actions || ctx.config.forget ? h("span", { class: "w-bt__actions" }, ctx.config.actions ? connect : null, ctx.config.forget ? forget : null) : null,
      );
    };

    function render() {
      const bt = ctx.data.state?.bluetooth;
      const devices = ctx.data.devices.filter((d) => !ctx.config.onlyConnected || d.connected);
      const connected = ctx.data.devices.filter((d) => d.connected);
      root.dataset.tier = ctx.tier;
      pairButton.hidden = !ctx.config.pairing || ctx.tier === "tiny";
      pairButton.disabled = busy.has("pairing");
      pairButton.textContent = bt?.pairing ? "Pairing: вкл" : "Pairing";
      pairButton.classList.toggle("w-btn--active", Boolean(bt?.pairing));
      status.textContent = connected.length ? `${bt?.name || "Станция"} · ${connected.map((d) => d.name || d.address).join(", ")}` : `${bt?.name || "Станция"} · нет подключений`;
      status.hidden = ctx.tier === "compact";
      if (ctx.tier === "tiny") { list.replaceChildren(); return; }
      // Compact: connected devices first, as many as fit; full list from regular up.
      const shown = ctx.tier === "compact" ? [...devices].sort((a, b) => Number(b.connected) - Number(a.connected)) : devices;
      list.replaceChildren(...shown.map(deviceRow));
      if (!devices.length) list.append(h("p", { class: "w-muted" }, "Нет сопряжённых устройств"));
    }

    return { update(next) { ctx = next; render(); } };
  },
};
