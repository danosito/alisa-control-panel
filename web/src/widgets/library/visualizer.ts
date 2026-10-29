import type { LiveFrame } from "../../api/live";
import { h } from "../../ui/dom";
import { animationLoop, createSurface, resample, SCHEME_OPTIONS, schemeColor, type Scheme } from "../canvas";
import type { WidgetContext, WidgetDefinition } from "../types";

type Mode = "bars" | "mirror" | "blocks" | "wave" | "circle" | "waterfall";
type Config = { mode: string; source: string; scheme: string; bars: number; peaks: boolean; fall: string; frame: boolean; cycle: boolean };

const MODES: Array<{ value: Mode; label: string }> = [
  { value: "bars", label: "Столбики" }, { value: "mirror", label: "Зеркало" }, { value: "blocks", label: "LED-блоки" },
  { value: "wave", label: "Осциллограф" }, { value: "circle", label: "Круг" }, { value: "waterfall", label: "Водопад" },
];
const FALL: Record<string, number> = { slow: 0.9, normal: 1.8, fast: 3.5 };

// cava-style visualiser of the live analyser stream. Rendering is local; the
// speaker sends 30 compact frames per second over the shared live socket.
export const visualizerWidget: WidgetDefinition<Config> = {
  id: "visualizer",
  title: "Визуализация",
  description: "Спектр в реальном времени: столбики, зеркало, блоки, осциллограф, круг, водопад",
  category: "Музыка",
  sizes: [{ w: 32, h: 12 }, { w: 16, h: 8 }, { w: 16, h: 16 }, { w: 48, h: 16 }, { w: 8, h: 24 }, { w: 16, h: 4 }],
  minSize: { w: 3, h: 2 },
  maxSize: { w: 64, h: 48 },
  aspect: [0.1, 32],
  defaultConfig: { mode: "bars", source: "playback", scheme: "accent", bars: 32, peaks: true, fall: "normal", frame: true, cycle: true },
  configSchema: [
    { key: "mode", label: "Режим", type: "select", options: MODES },
    { key: "source", label: "Источник", type: "select", options: [{ value: "playback", label: "Что играет колонка" }, { value: "mic", label: "Микрофон" }] },
    { key: "scheme", label: "Цвета", type: "select", options: SCHEME_OPTIONS },
    { key: "bars", label: "Полос", type: "number", min: 8, max: 96, step: 4 },
    { key: "fall", label: "Скорость спада", type: "select", options: [{ value: "slow", label: "Плавно" }, { value: "normal", label: "Обычно" }, { value: "fast", label: "Резко" }] },
    { key: "peaks", label: "Пиковые метки", type: "checkbox" },
    { key: "cycle", label: "Клик переключает режим", type: "checkbox" },
    { key: "frame", label: "Карточка", type: "checkbox" },
  ],
  sync: (config) => (config.scheme === "led" ? { kind: "dashboard", intervalMs: 5000 } : { kind: "none" }),
  mount(host, initial) {
    let ctx: WidgetContext<Config> = initial;
    let override: Mode | null = null;
    const label = h("span", { class: "w-viz__label" });
    const status = h("span", { class: "w-viz__status" });
    const stage = h("div", { class: "w-viz__stage" });
    const root = h("div", { class: "w w-viz" }, stage, label, status);
    host.append(root);
    const surface = createSurface(stage, () => { waterfall = null; draw(0); });

    let bars = new Float32Array(32), targets = new Float32Array(32), peaks = new Float32Array(32), peakHold = new Float32Array(32);
    let wave = new Float32Array(128), waveTarget: Float32Array = new Float32Array(128);
    let level = 0, bass = 0, beatGlow = 0, lastFrame = 0, connected = true, rotation = 0;
    let waterfall: HTMLCanvasElement | null = null;
    let labelTimer: number | undefined;

    const mode = (): Mode => override ?? ((MODES.some((m) => m.value === ctx.config.mode) ? ctx.config.mode : "bars") as Mode);
    const scheme = () => ctx.config.scheme as Scheme;
    const led = () => ctx.data.state?.led.color;
    const color = (t: number, alpha = 1) => schemeColor(scheme(), t, led(), alpha);

    const ensureCount = () => {
      const n = Math.max(8, Math.min(96, Math.round(Number(ctx.config.bars) || 32)));
      if (bars.length === n) return;
      bars = new Float32Array(n); targets = new Float32Array(n); peaks = new Float32Array(n); peakHold = new Float32Array(n);
    };

    const onFrame = (frame: LiveFrame) => {
      ensureCount();
      resample(frame.bands, targets.length, targets);
      waveTarget = frame.wave;
      if (wave.length !== waveTarget.length) wave = new Float32Array(waveTarget.length);
      level = frame.level; bass = frame.bass;
      if (frame.beat) beatGlow = 1;
      lastFrame = performance.now();
      if (mode() === "waterfall") pushWaterfall(frame.bands);
      loop.start();
    };

    let unsubscribe = () => {};
    let subscribedSource = "";
    const subscribe = () => {
      if (subscribedSource === ctx.config.source) return;
      unsubscribe();
      subscribedSource = ctx.config.source;
      unsubscribe = ctx.live.subscribe(ctx.config.source === "mic" ? { mic: true } : { playback: true }, { frame: onFrame, status: (ok) => { connected = ok; loop.start(); } });
    };

    const pushWaterfall = (bands: Float32Array) => {
      const { width, height } = surface;
      if (!waterfall) { waterfall = document.createElement("canvas"); waterfall.width = Math.max(1, width); waterfall.height = Math.max(1, height); }
      const w = waterfall.getContext("2d")!;
      const step = 2;
      w.drawImage(waterfall, -step, 0);
      const rows = bands.length;
      for (let i = 0; i < rows; i++) {
        const v = bands[i]!;
        w.fillStyle = v < 0.04 ? "#05070a" : color(v, Math.min(1, 0.15 + v));
        const y0 = height - ((i + 1) * height) / rows, y1 = height - (i * height) / rows;
        w.fillRect(waterfall.width - step, y0, step, y1 - y0 + 1);
      }
    };

    function draw(dt: number): boolean {
      const { ctx: g, width: W, height: H } = surface;
      const fall = FALL[ctx.config.fall] ?? 1.8;
      const stale = performance.now() - lastFrame > 800;
      if (stale) targets.fill(0);
      let active = false;
      for (let i = 0; i < bars.length; i++) {
        const t = targets[i]!;
        bars[i] = t > bars[i]! ? bars[i]! + (t - bars[i]!) * 0.7 : Math.max(t, bars[i]! - fall * dt * (0.35 + bars[i]!));
        if (bars[i]! > peaks[i]!) { peaks[i] = bars[i]!; peakHold[i] = 0.35; }
        else if ((peakHold[i] = peakHold[i]! - dt) < 0) peaks[i] = Math.max(0, peaks[i]! - dt * 0.6);
        if (bars[i]! > 0.002 || peaks[i]! > 0.002) active = true;
      }
      for (let i = 0; i < wave.length; i++) wave[i] = wave[i]! + ((stale ? 0 : waveTarget[i] ?? 0) - wave[i]!) * 0.5;
      beatGlow = Math.max(0, beatGlow - dt * 3);
      rotation += dt * (0.08 + level * 0.25);
      g.clearRect(0, 0, W, H);
      const m = mode();
      const portrait = H > W * 1.4 && (m === "bars" || m === "mirror" || m === "blocks");
      if (m === "bars") drawBars(g, W, H, portrait, false);
      else if (m === "mirror") drawBars(g, W, H, portrait, true);
      else if (m === "blocks") drawBlocks(g, W, H, portrait);
      else if (m === "wave") drawWave(g, W, H);
      else if (m === "circle") drawCircle(g, W, H);
      else if (m === "waterfall") { if (waterfall) g.drawImage(waterfall, 0, 0, W, H); active = !stale; }
      status.textContent = !connected ? "нет связи с колонкой" : stale ? "тишина" : "";
      return active || !stale || beatGlow > 0;
    }

    function drawBars(g: CanvasRenderingContext2D, W: number, H: number, portrait: boolean, mirror: boolean): void {
      const n = bars.length;
      const along = portrait ? H : W, across = portrait ? W : H;
      const slot = along / n, gap = Math.max(1, slot * 0.22), thick = Math.max(1, slot - gap);
      const radius = Math.min(thick / 2, 3);
      for (let i = 0; i < n; i++) {
        // Mirror: low frequencies in the middle, spreading out to both sides.
        const index = mirror ? Math.abs(i - (n - 1) / 2) * 2 : i;
        const v = bars[Math.round(Math.min(n - 1, index))]!;
        const len = Math.max(1.5, v * across * (mirror ? 0.5 : 0.96));
        const pos = i * slot + gap / 2;
        g.fillStyle = barGradient(g, portrait, across, mirror, v);
        if (portrait) {
          const y = H - pos - thick;
          if (mirror) roundRect(g, W / 2 - len, y, len * 2, thick, radius); else roundRect(g, 0, y, len, thick, radius);
        } else if (mirror) roundRect(g, pos, H / 2 - len, thick, len * 2, radius);
        else roundRect(g, pos, H - len, thick, len, radius);
        if (ctx.config.peaks && !mirror) {
          const p = peaks[Math.round(Math.min(n - 1, index))]! * across * 0.96;
          g.fillStyle = color(1, 0.85);
          if (portrait) g.fillRect(Math.max(0, p - 2), H - pos - thick, 2, thick); else g.fillRect(pos, Math.max(0, H - p - 2), thick, 2);
        }
      }
    }

    function barGradient(g: CanvasRenderingContext2D, portrait: boolean, across: number, mirror: boolean, v: number): CanvasGradient | string {
      if (scheme() === "rainbow") return color(v);
      if (mirror) {
        // Symmetric around the centre line: bright at both tips.
        const grad = portrait ? g.createLinearGradient(0, 0, surface.width, 0) : g.createLinearGradient(0, 0, 0, surface.height);
        grad.addColorStop(0, color(1)); grad.addColorStop(0.5, color(0.05)); grad.addColorStop(1, color(1));
        return grad;
      }
      const grad = portrait ? g.createLinearGradient(0, 0, across, 0) : g.createLinearGradient(0, across, 0, 0);
      grad.addColorStop(0, color(0.05)); grad.addColorStop(0.6, color(0.55)); grad.addColorStop(1, color(1));
      return grad;
    }

    function drawBlocks(g: CanvasRenderingContext2D, W: number, H: number, portrait: boolean): void {
      const n = bars.length;
      const along = portrait ? H : W, across = portrait ? W : H;
      const slot = along / n, gap = Math.max(1, slot * 0.25), thick = Math.max(1, slot - gap);
      const cell = Math.max(3, Math.min(8, across / 24)), cellGap = Math.max(1, cell * 0.35);
      const cells = Math.floor(across / (cell + cellGap));
      for (let i = 0; i < n; i++) {
        const lit = Math.round(bars[i]! * cells), peak = Math.round(peaks[i]! * cells);
        const pos = i * slot + gap / 2;
        for (let c = 0; c < cells; c++) {
          const on = c < lit, isPeak = ctx.config.peaks && c === peak && peak > 0;
          if (!on && !isPeak) { g.fillStyle = "rgba(255,255,255,.035)"; }
          else g.fillStyle = color(c / Math.max(1, cells - 1), isPeak && !on ? 0.7 : 1);
          const offset = c * (cell + cellGap);
          if (portrait) g.fillRect(offset, H - pos - thick, cell, thick); else g.fillRect(pos, H - offset - cell, thick, cell);
        }
      }
    }

    function drawWave(g: CanvasRenderingContext2D, W: number, H: number): void {
      const mid = H / 2, amp = H * 0.42;
      g.lineWidth = Math.max(1.5, Math.min(3, H / 60));
      g.lineJoin = "round";
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, color(0.1)); grad.addColorStop(0.5, color(0.7)); grad.addColorStop(1, color(1));
      g.strokeStyle = grad;
      g.shadowColor = color(0.8, 0.8); g.shadowBlur = 8 + beatGlow * 14;
      g.beginPath();
      for (let i = 0; i < wave.length; i++) {
        const x = (i / (wave.length - 1)) * W, y = mid - wave[i]! * amp;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      g.shadowBlur = 0;
      g.globalAlpha = 0.18; g.lineWidth = 1; g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke(); g.globalAlpha = 1;
    }

    function drawCircle(g: CanvasRenderingContext2D, W: number, H: number): void {
      const cx = W / 2, cy = H / 2, size = Math.min(W, H);
      const r0 = size * (0.2 + bass * 0.05 + beatGlow * 0.025), maxLen = size * 0.27;
      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, r0 * 1.6);
      glow.addColorStop(0, color(0.6, 0.18 + level * 0.3)); glow.addColorStop(1, color(0.6, 0));
      g.fillStyle = glow; g.fillRect(0, 0, W, H);
      const n = bars.length, total = n * 2;
      g.lineCap = "round";
      g.lineWidth = Math.max(1.5, ((Math.PI * 2 * r0) / total) * 0.55);
      for (let k = 0; k < total; k++) {
        const i = k < n ? k : total - 1 - k; // symmetric ring
        const v = bars[i]!;
        const a = rotation + (k / total) * Math.PI * 2;
        const len = 2 + v * maxLen;
        g.strokeStyle = color(v);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
        g.stroke();
      }
      g.strokeStyle = color(0.9, 0.5 + beatGlow * 0.5); g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, r0 - 3, 0, Math.PI * 2); g.stroke();
    }

    const loop = animationLoop(stage, (dt) => draw(dt));

    root.addEventListener("click", () => {
      if (!ctx.config.cycle) return;
      const index = MODES.findIndex((m) => m.value === mode());
      override = MODES[(index + 1) % MODES.length]!.value;
      waterfall = null;
      label.textContent = MODES.find((m) => m.value === override)!.label;
      label.classList.add("w-viz__label--show");
      window.clearTimeout(labelTimer);
      labelTimer = window.setTimeout(() => label.classList.remove("w-viz__label--show"), 1200);
      loop.start();
    });

    return {
      update(next) {
        const modeChanged = next.config.mode !== ctx.config.mode;
        ctx = next;
        if (modeChanged) { override = null; waterfall = null; }
        root.dataset.tier = next.tier;
        root.classList.toggle("w--frameless", !next.config.frame);
        root.classList.toggle("w-viz--clickable", Boolean(next.config.cycle));
        ensureCount();
        subscribe();
        loop.start();
      },
      destroy() { unsubscribe(); loop.destroy(); surface.destroy(); window.clearTimeout(labelTimer); },
    };
  },
};

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (w <= 0 || h <= 0) return;
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.roundRect(x, y, w, h, rr);
  g.fill();
}
