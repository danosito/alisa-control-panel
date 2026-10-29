// Widget kit: renders every registered widget at every size tier with fixture
// data, using the same WidgetHost as production. Build: node scripts/build.mjs --kit
import { playbackRecording } from "../demo/recording";
import { fixtureApi, fixtureData, fixtureLive } from "../widgets/fixtures";
import { WidgetHost } from "../widgets/host";
import { registerLibrary } from "../widgets/library";
import { listWidgets } from "../widgets/registry";
import { tierOf, type GridSize } from "../widgets/types";
import { h } from "../ui/dom";

const CELL = 28; // ≈ one grid unit on a 1920px desktop (64 columns)
const TIER_PROBES: GridSize[] = [{ w: 4, h: 2 }, { w: 8, h: 4 }, { w: 16, h: 4 }, { w: 12, h: 10 }, { w: 16, h: 16 }, { w: 32, h: 16 }, { w: 16, h: 32 }, { w: 32, h: 32 }, { w: 6, h: 18 }, { w: 8, h: 24 }, { w: 10, h: 20 }];

registerLibrary();
const api = fixtureApi();
const data = fixtureData();
const live = fixtureLive(playbackRecording);
const params = new URLSearchParams(location.search);
const only = params.get("widget");
// ?config={"mode":"wave"} applies the same config to every rendered size.
const config = JSON.parse(params.get("config") ?? "{}") as Record<string, string | number | boolean>;
const root = document.getElementById("app")!;
root.className = "kit";

for (const definition of listWidgets().filter((d) => !only || d.id === only)) {
  const sizes = [...definition.sizes, ...TIER_PROBES].filter((s, i, all) => all.findIndex((o) => o.w === s.w && o.h === s.h) === i)
    .filter((s) => s.w >= definition.minSize.w && s.h >= definition.minSize.h && s.w <= definition.maxSize.w && s.h <= definition.maxSize.h && s.w / s.h >= definition.aspect[0] && s.w / s.h <= definition.aspect[1]);
  const row = h("div", { class: "kit__row" });
  for (const size of sizes) {
    const host = new WidgetHost({ api, live, widgetId: definition.id, config, size, data, preview: true });
    row.append(h("figure", { class: "kit__cell" },
      h("div", { class: "kit__frame", style: `width:${size.w * CELL}px;height:${size.h * CELL}px` }, host.el),
      h("figcaption", {}, `${size.w}×${size.h} · ${tierOf(size)}`)));
  }
  root.append(h("section", { class: "kit__widget", id: definition.id }, h("h2", {}, `${definition.title} `, h("code", {}, definition.id)), row));
}

const style = document.createElement("style");
style.textContent = `.kit{padding:24px;display:grid;gap:36px;background:var(--bg)}.kit h2{margin:0 0 12px;font-size:15px}.kit h2 code{color:var(--muted);font-size:12px}.kit__row{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-start}.kit__cell{margin:0;display:grid;gap:6px}.kit__frame{position:relative}.kit__cell figcaption{color:var(--muted);font:11px var(--font-mono)}`;
document.head.append(style);
