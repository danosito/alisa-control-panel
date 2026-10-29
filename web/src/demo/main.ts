// Demo: the real interface on fake data, no station needed.
// Build: npm run demo -> web/dist/demo.html (open via any static HTTP server).
//   demo.html                 workspace (Главная / Мониторинг / Музыка)
//   demo.html?screen=login    login screen
import type { Metrics } from "../api/types";
import { createAuthScreen } from "../ui/authScreen";
import { h } from "../ui/dom";
import { createWorkspace } from "../ui/workspace";
import { fixtureApi, fixtureData, fixtureLive } from "../widgets/fixtures";
import { registerLibrary } from "../widgets/library";
import { findWidget } from "../widgets/registry";
import { playbackRecording } from "./recording";

registerLibrary();
// Relative, so the demo works from any folder (or GitHub Pages).
const image = findWidget("image");
if (image) image.defaultConfig = { ...image.defaultConfig, src: "assets/logo.svg" };
const root = document.getElementById("app")!;
const api = fixtureApi();

if (new URLSearchParams(location.search).get("screen") === "login") {
  const screen = createAuthScreen(api, () => undefined);
  screen.setStatus({ configured: true, owner: "", passkeys: 0, mode: "password", name: "Станция" });
  root.replaceChildren(h("div", { class: "app-shell" }, screen.el));
} else {
  const live = fixtureLive(playbackRecording);
  const workspace = createWorkspace(api, live, { onLogout: () => undefined, onRefresh: () => undefined, owner: "demo", preview: true });
  root.replaceChildren(h("div", { class: "app-shell" }, workspace.el));
  // Keep charts moving: one new metrics sample per second, like the station.
  const data = fixtureData();
  let cpu = data.metrics!.cpu_percent;
  const tick = () => {
    cpu = Math.min(85, Math.max(4, cpu + (Math.random() - 0.48) * 9));
    const last = data.history[data.history.length - 1]!;
    const sample: Metrics = { ...last, cpu_percent: cpu, ram_used_mb: Math.round(150 + 8 * Math.sin(Date.now() / 20000)), net_rx_kbps: 250 + Math.random() * 400, net_tx_kbps: 30 + Math.random() * 60 };
    data.history = [...data.history.slice(1), sample];
    data.metrics = sample;
    workspace.setData({ ...data });
  };
  queueMicrotask(tick);
  window.setInterval(tick, 1000);
}
