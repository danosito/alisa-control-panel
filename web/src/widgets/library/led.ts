import iro from "@jaames/iro";
import type { LedModePatch } from "../../api/client";
import type { LedState, LightAlgo, LightMode } from "../../api/types";
import { h } from "../../ui/dom";
import type { WidgetContext, WidgetDefinition } from "../types";

type Config = { presets: boolean; brightness: boolean; modes: boolean; tuning: boolean };
type Rgb = { r: number; g: number; b: number };

const PRESETS: Array<{ label: string; rgb: Rgb }> = [
  { label: "Тёплый", rgb: { r: 255, g: 140, b: 40 } },
  { label: "Белый", rgb: { r: 255, g: 255, b: 255 } },
  { label: "Красный", rgb: { r: 255, g: 20, b: 0 } },
  { label: "Зелёный", rgb: { r: 0, g: 255, b: 70 } },
  { label: "Синий", rgb: { r: 0, g: 80, b: 255 } },
  { label: "Фиолетовый", rgb: { r: 168, g: 85, b: 247 } },
];

const MODES: Array<{ value: LightMode; label: string; short: string }> = [
  { value: "static", label: "Цвет", short: "●" },
  { value: "breathe", label: "Дыхание", short: "◐" },
  { value: "rainbow", label: "Радуга", short: "◈" },
  { value: "candle", label: "Свеча", short: "✦" },
  { value: "music", label: "Музыка", short: "♫" },
];
const ALGOS: Array<{ value: LightAlgo; label: string; hint: string }> = [
  { value: "pulse", label: "Пульс", hint: "яркость следует за громкостью" },
  { value: "spectrum", label: "Спектр", hint: "зоны: басы, середина, верха" },
  { value: "beat", label: "Бит", hint: "вспышки и смена цвета на долях" },
  { value: "flow", label: "Поток", hint: "оттенок следует за тембром" },
];

const css = ({ r, g, b }: Rgb, alpha = 1) => `rgb(${r} ${g} ${b} / ${alpha})`;
const DEFAULT_STATE: LedState = { mode: "off", algo: "pulse", color: { r: 0, g: 0, b: 0, brightness: 0 }, speed: 50, sensitivity: 50 };

// The ring is driven by the light engine on the speaker: modes keep running
// with the page closed. The widget edits the engine's configuration.
export const ledWidget: WidgetDefinition<Config> = {
  id: "led",
  title: "Подсветка",
  description: "Кольцо RGB: цвет, яркость, режимы и светомузыка",
  category: "Железо",
  sizes: [{ w: 16, h: 16 }, { w: 24, h: 16 }, { w: 16, h: 8 }, { w: 32, h: 16 }, { w: 8, h: 4 }, { w: 8, h: 20 }],
  minSize: { w: 3, h: 2 },
  maxSize: { w: 48, h: 48 },
  aspect: [0.3, 8],
  defaultConfig: { presets: true, brightness: true, modes: true, tuning: true },
  configSchema: [
    { key: "modes", label: "Режимы (цвет, дыхание, радуга, свеча, музыка)", type: "checkbox" },
    { key: "tuning", label: "Скорость и чувствительность", type: "checkbox" },
    { key: "presets", label: "Пресеты цветов", type: "checkbox" },
    { key: "brightness", label: "Слайдер яркости", type: "checkbox" },
  ],
  sync: () => ({ kind: "dashboard", intervalMs: 5000 }),
  mount(host, initial) {
    let ctx: WidgetContext<Config> = initial;
    let interacting = false;
    let local: { state: LedState; until: number } | null = null;
    let lastMode: LightMode = "static";
    let pending: number | undefined;
    let pendingPatch: LedModePatch = {};

    const swatch = h("span", { class: "w-led__swatch", role: "button", title: "Вкл/выкл" });
    const toggle = h("button", { class: "w-led__toggle", type: "button" }) as HTMLButtonElement;
    const modeRow = h("div", { class: "w-led__modes", role: "tablist" });
    const algoRow = h("div", { class: "w-led__algos" });
    const algoHint = h("span", { class: "w-led__hint" });
    const speed = h("input", { class: "w-led__range", type: "range", min: "1", max: "100", "aria-label": "Скорость" }) as HTMLInputElement;
    const sensitivity = h("input", { class: "w-led__range", type: "range", min: "1", max: "100", "aria-label": "Чувствительность" }) as HTMLInputElement;
    const speedField = h("label", { class: "w-led__tune" }, h("span", {}, "Скорость"), speed);
    const sensField = h("label", { class: "w-led__tune" }, h("span", {}, "Чувствительность"), sensitivity);
    const tuning = h("div", { class: "w-led__tuning" }, speedField, sensField);
    const presetRow = h("div", { class: "w-led__presets" });
    const pickerHost = h("div", { class: "w-led__picker" });
    const controls = h("div", { class: "w-led__controls" }, h("div", { class: "w-led__head" }, swatch, toggle), modeRow, algoRow, algoHint, tuning, presetRow);
    const root = h("div", { class: "w w-led" }, pickerHost, controls);
    host.append(root);

    const picker = iro.ColorPicker(pickerHost, {
      width: 160, borderWidth: 1, borderColor: "#3a4553", handleRadius: 7, padding: 4, layoutDirection: "vertical",
      layout: [{ component: iro.ui.Wheel }, { component: iro.ui.Slider, options: { sliderType: "value" } }],
    });

    const state = (): LedState => (local && local.until > performance.now() ? local.state : ctx.data.state?.led ?? DEFAULT_STATE);
    const isOn = (s: LedState) => s.mode !== "off" && s.color.brightness > 0 && s.color.r + s.color.g + s.color.b > 0;

    /** Optimistic local state, then one debounced request with the merged patch. */
    const change = (patch: LedModePatch) => {
      const s = state();
      const next: LedState = {
        mode: patch.mode ?? s.mode, algo: patch.algo ?? s.algo, speed: patch.speed ?? s.speed, sensitivity: patch.sensitivity ?? s.sensitivity,
        color: { r: patch.r ?? s.color.r, g: patch.g ?? s.color.g, b: patch.b ?? s.color.b, brightness: patch.brightness ?? s.color.brightness },
      };
      local = { state: next, until: performance.now() + 2500 };
      if (next.mode !== "off") lastMode = next.mode;
      render();
      if (ctx.preview) return;
      pendingPatch = { ...pendingPatch, ...patch };
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        const body = pendingPatch; pendingPatch = {};
        void ctx.api.ledMode(body).then(() => ctx.refresh()).catch(() => { local = null; render(); });
      }, 70);
    };

    const fromPicker = () => {
      const hsv = picker.color.hsv;
      const full = new iro.Color({ h: hsv.h ?? 0, s: hsv.s ?? 0, v: 100 }).rgb;
      const brightness = Math.round(((hsv.v ?? 0) / 100) * 255);
      const s = state();
      change({ r: full.r, g: full.g, b: full.b, brightness, ...(s.mode === "off" ? { mode: lastMode } : {}) });
    };
    picker.on("input:start", () => { interacting = true; });
    picker.on("input:change", fromPicker);
    picker.on("input:end", () => { interacting = false; fromPicker(); });

    const flip = () => {
      const s = state();
      if (isOn(s)) change({ mode: "off" });
      else change({ mode: lastMode === "off" ? "static" : lastMode, ...(s.color.brightness === 0 || s.color.r + s.color.g + s.color.b === 0 ? { r: 255, g: 140, b: 40, brightness: 200 } : {}) });
    };
    toggle.addEventListener("click", flip);
    swatch.addEventListener("click", flip); // on micro sizes the swatch is the only control
    presetRow.replaceChildren(...PRESETS.map((preset) => h("button", { class: "w-led__preset", type: "button", title: preset.label, "aria-label": preset.label, style: `background:${css(preset.rgb)}`, onclick: () => change({ ...preset.rgb, brightness: Math.max(state().color.brightness, 160), ...(state().mode === "off" ? { mode: lastMode } : {}) }) })));
    const modeButtons = MODES.map((m) => {
      const b = h("button", { class: "w-led__chip", type: "button", role: "tab", title: m.label, "data-mode": m.value, onclick: () => change({ mode: m.value }) }, h("span", { class: "w-led__chip-icon" }, m.short), h("span", { class: "w-led__chip-label" }, m.label)) as HTMLButtonElement;
      return b;
    });
    modeRow.replaceChildren(...modeButtons);
    const algoButtons = ALGOS.map((a) => h("button", { class: "w-led__chip w-led__chip--algo", type: "button", title: a.hint, onclick: () => change({ algo: a.value, mode: "music" }) }, a.label) as HTMLButtonElement);
    algoRow.replaceChildren(...algoButtons);
    speed.addEventListener("input", () => change({ speed: Number(speed.value) }));
    sensitivity.addEventListener("input", () => change({ sensitivity: Number(sensitivity.value) }));

    // Music mode: let the swatch breathe with the music the engine reacts to.
    let unsubscribeLive: (() => void) | null = null;
    const followMusic = (on: boolean) => {
      if (on && !unsubscribeLive) unsubscribeLive = ctx.live.subscribe({ playback: true }, { frame: (f) => { swatch.style.setProperty("--pulse", f.level.toFixed(3)); } });
      if (!on && unsubscribeLive) { unsubscribeLive(); unsubscribeLive = null; swatch.style.removeProperty("--pulse"); }
    };

    function render(): void {
      const s = state();
      const on = isOn(s);
      if (s.mode !== "off") lastMode = s.mode;
      const color = s.color;
      root.dataset.mode = s.mode;
      swatch.style.background = on ? css(color, Math.max(0.3, color.brightness / 255)) : "transparent";
      swatch.style.setProperty("--glow", on ? css(color, 0.85) : "transparent");
      toggle.textContent = on ? "Выключить" : "Включить";
      toggle.classList.toggle("w-led__toggle--on", on);
      for (const b of modeButtons) b.classList.toggle("w-led__chip--active", b.dataset.mode === s.mode);
      const music = s.mode === "music";
      const small = ctx.tier === "tiny" || ctx.tier === "slim" || ctx.tier === "compact";
      // A 16×16 tile keeps the wheel big: sliders and hints from 24 units up.
      const roomy = !small && ctx.tier !== "regular";
      algoRow.hidden = !ctx.config.modes || !music || ctx.tier === "tiny";
      algoHint.hidden = algoRow.hidden || !roomy;
      ALGOS.forEach((a, i) => algoButtons[i]!.classList.toggle("w-led__chip--active", a.value === s.algo));
      algoHint.textContent = ALGOS.find((a) => a.value === s.algo)?.hint ?? "";
      const animated = s.mode !== "static" && s.mode !== "off";
      tuning.hidden = !ctx.config.tuning || !animated || !roomy;
      sensField.hidden = !music;
      if (document.activeElement !== speed) speed.value = String(s.speed);
      if (document.activeElement !== sensitivity) sensitivity.value = String(s.sensitivity);
      if (!interacting && color.r + color.g + color.b > 0) {
        picker.color.rgb = { r: color.r, g: color.g, b: color.b };
        picker.color.value = (color.brightness / 255) * 100;
      }
      followMusic(music && on);
    }

    const fit = () => {
      const { width, height } = pickerHost.getBoundingClientRect();
      const sliderAllowance = ctx.config.brightness ? 40 : 0;
      const size = Math.floor(Math.max(60, Math.min(width, height - sliderAllowance)));
      if (size > 0 && Math.abs(size - (picker.props.width ?? 0)) > 2) picker.resize(size);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(pickerHost);

    return {
      update(next) {
        ctx = next;
        root.dataset.tier = next.tier;
        root.dataset.orientation = next.orientation;
        presetRow.hidden = !next.config.presets || next.tier === "tiny" || next.tier === "slim";
        modeRow.hidden = !next.config.modes || next.tier === "tiny";
        const slider = pickerHost.querySelector<HTMLElement>(".IroSlider");
        if (slider) slider.style.display = next.config.brightness ? "" : "none";
        pickerHost.hidden = next.tier === "tiny" || next.tier === "compact" || next.tier === "slim";
        if (local && local.until <= performance.now()) local = null;
        render();
        fit();
      },
      destroy() { observer.disconnect(); window.clearTimeout(pending); followMusic(false); },
    };
  },
};
