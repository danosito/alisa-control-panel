import type { LiveFrame } from "../../api/live";
import { h } from "../../ui/dom";
import { animationLoop, createSurface, resample } from "../canvas";
import type { WidgetContext, WidgetDefinition } from "../types";

type Config = { spectrum: boolean; numbers: boolean };

const MIN_DB = -80, MAX_DB = -10;
const norm = (db: number) => Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));

// Raw PDM microphones (hw:0,1) captured by the panel itself, without the Yandex
// stack: two channels, 48 kHz. Shows levels with peak hold and a spectrum.
export const microphoneWidget: WidgetDefinition<Config> = {
  id: "microphone",
  title: "Микрофон",
  description: "Уровни двух PDM-микрофонов и спектр в реальном времени",
  category: "Железо",
  sizes: [{ w: 24, h: 12 }, { w: 16, h: 8 }, { w: 16, h: 4 }, { w: 8, h: 16 }, { w: 16, h: 16 }],
  minSize: { w: 3, h: 2 },
  maxSize: { w: 48, h: 32 },
  aspect: [0.2, 16],
  defaultConfig: { spectrum: true, numbers: true },
  configSchema: [
    { key: "spectrum", label: "Спектр", type: "checkbox" },
    { key: "numbers", label: "Значения в дБ", type: "checkbox" },
  ],
  sync: () => ({ kind: "none" }),
  mount(host, initial) {
    let ctx: WidgetContext<Config> = initial;
    const status = h("span", { class: "w-mic__status" }, "подключаюсь…");
    const values = h("span", { class: "w-mic__values" });
    const stage = h("div", { class: "w-mic__stage" });
    const root = h("div", { class: "w w-mic" }, h("header", { class: "w-head" }, h("strong", { class: "w-head__title" }, "Микрофон"), status), stage, values);
    host.append(root);
    const surface = createSurface(stage, () => draw(0));

    const level = [0, 0], peak = [0, 0], hold = [0, 0];
    const target = [0, 0];
    const spectrum = new Float32Array(24), spectrumTarget = new Float32Array(24);
    let lastFrame = 0, connected = false, db: [number, number] = [MIN_DB, MIN_DB];

    const onFrame = (frame: LiveFrame) => {
      db = frame.micDb;
      target[0] = norm(frame.micDb[0]); target[1] = norm(frame.micDb[1]);
      resample(frame.bands, spectrum.length, spectrumTarget);
      lastFrame = performance.now();
      loop.start();
    };

    const renderStatus = () => {
      const stale = performance.now() - lastFrame > 1500;
      status.textContent = !connected ? "нет связи" : stale ? "нет сигнала" : "PDM · 2 мик · 48 кГц";
      status.classList.toggle("w-mic__status--live", connected && !stale);
      values.textContent = ctx.config.numbers && !stale ? `${Math.round(db[0])} / ${Math.round(db[1])} дБ` : "";
    };
    let statusTick = 0;

    function draw(dt: number): boolean {
      const { ctx: g, width: W, height: H } = surface;
      const stale = performance.now() - lastFrame > 1500;
      for (let c = 0; c < 2; c++) {
        const t = stale ? 0 : target[c]!;
        level[c] = t > level[c]! ? t : Math.max(t, level[c]! - dt * 1.4);
        if (level[c]! >= peak[c]!) { peak[c] = level[c]!; hold[c] = 1; } else if ((hold[c] = hold[c]! - dt) < 0) peak[c] = Math.max(0, peak[c]! - dt * 0.5);
      }
      for (let i = 0; i < spectrum.length; i++) spectrum[i] = spectrum[i]! + ((stale ? 0 : spectrumTarget[i]!) - spectrum[i]!) * Math.min(1, dt * 14);
      g.clearRect(0, 0, W, H);
      const vertical = H > W * 1.2;
      const showSpectrum = ctx.config.spectrum && (vertical ? H > 120 : H > 54);
      const meterSpace = showSpectrum ? (vertical ? H * 0.55 : H * 0.45) : vertical ? H : H;
      const gap = 6;
      for (let c = 0; c < 2; c++) {
        const grad = vertical ? g.createLinearGradient(0, meterSpace, 0, 0) : g.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, "#22c55e"); grad.addColorStop(0.7, "#eab308"); grad.addColorStop(1, "#ef4444");
        if (vertical) {
          const bw = (W - gap) / 2, x = c * (bw + gap);
          g.fillStyle = "rgba(255,255,255,.05)"; g.beginPath(); g.roundRect(x, 0, bw, meterSpace, 4); g.fill();
          g.fillStyle = grad; g.beginPath(); g.roundRect(x, meterSpace * (1 - level[c]!), bw, meterSpace * level[c]!, 4); g.fill();
          g.fillStyle = "#f8fafc"; g.fillRect(x, meterSpace * (1 - peak[c]!), bw, 2);
        } else {
          const bh = Math.min(16, (meterSpace - gap) / 2), y = c * (bh + gap);
          g.fillStyle = "rgba(255,255,255,.05)"; g.beginPath(); g.roundRect(0, y, W, bh, 4); g.fill();
          g.fillStyle = grad; g.beginPath(); g.roundRect(0, y, W * level[c]!, bh, 4); g.fill();
          g.fillStyle = "#f8fafc"; g.fillRect(W * peak[c]! - 1, y, 2, bh);
        }
      }
      if (showSpectrum) {
        const top = meterSpace + gap * 1.5, height = H - top, n = spectrum.length, slot = W / n;
        for (let i = 0; i < n; i++) {
          const v = spectrum[i]!, bh = Math.max(1, v * height);
          g.fillStyle = `hsl(${190 + i * 4} 80% ${45 + v * 25}%)`;
          g.beginPath(); g.roundRect(i * slot + 1, top + height - bh, Math.max(1, slot - 2), bh, 2); g.fill();
        }
      }
      if ((statusTick += dt) > 0.25) { statusTick = 0; renderStatus(); }
      return !stale || level.some((l) => l > 0.001) || peak.some((p) => p > 0.001);
    }
    const loop = animationLoop(stage, (dt) => draw(dt));
    const idle = window.setInterval(renderStatus, 1000);
    // Subscribe last: the status callback fires synchronously.
    const unsubscribe = ctx.live.subscribe({ mic: true }, { frame: onFrame, status: (ok) => { connected = ok; renderStatus(); } });

    return {
      update(next) { ctx = next; root.dataset.tier = next.tier; renderStatus(); loop.start(); },
      destroy() { unsubscribe(); loop.destroy(); surface.destroy(); window.clearInterval(idle); },
    };
  },
};
