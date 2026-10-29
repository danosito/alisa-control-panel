import { h, svgIcon } from "../../ui/dom";
import type { WidgetContext, WidgetDefinition } from "../types";

type Config = { label: boolean; step: number };

const SPEAKER = '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor" stroke="none"/>';
const WAVES = '<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>';
const MUTED = '<path d="M16 9.5l5 5M21 9.5l-5 5"/>';

// Master volume of the speaker (softvol "Master"), independent of the volume
// the phone/PC sends over Bluetooth. Vertical in tall shapes, horizontal otherwise.
export const volumeWidget: WidgetDefinition<Config> = {
  id: "volume",
  title: "Громкость",
  description: "Общая громкость колонки; вертикальный или горизонтальный слайдер",
  category: "Музыка",
  sizes: [{ w: 8, h: 16 }, { w: 16, h: 4 }, { w: 6, h: 24 }, { w: 24, h: 6 }],
  minSize: { w: 2, h: 2 },
  maxSize: { w: 32, h: 48 },
  aspect: [0.08, 14],
  defaultConfig: { label: true, step: 5 },
  configSchema: [
    { key: "label", label: "Показывать проценты", type: "checkbox" },
    { key: "step", label: "Шаг колёсика, %", type: "number", min: 1, max: 20, step: 1 },
  ],
  sync: () => ({ kind: "dashboard", intervalMs: 5000 }),
  mount(host, initial) {
    let ctx: WidgetContext<Config> = initial;
    let value = ctx.data.state?.audio.volume ?? 50;
    let localUntil = 0;
    let beforeMute = value > 0 ? value : 50;
    let sendTimer: number | undefined;
    let lastSent = -1;

    const fill = h("div", { class: "w-vol__fill" });
    const knob = h("div", { class: "w-vol__knob" });
    const track = h("div", { class: "w-vol__track", role: "slider", tabindex: "0", "aria-label": "Громкость", "aria-valuemin": "0", "aria-valuemax": "100" }, fill, knob);
    const label = h("span", { class: "w-vol__value" });
    const mute = h("button", { class: "w-vol__mute", type: "button", title: "Выключить звук" }) as HTMLButtonElement;
    const root = h("div", { class: "w w-vol" }, label, track, mute);
    host.append(root);

    const vertical = () => root.dataset.dir === "v";
    const send = () => {
      window.clearTimeout(sendTimer);
      sendTimer = window.setTimeout(() => {
        if (ctx.preview || Math.round(value) === lastSent) return;
        lastSent = Math.round(value);
        void ctx.api.volumeSet(lastSent).catch(() => undefined);
      }, 90);
    };
    const set = (next: number, commit = true) => {
      value = Math.max(0, Math.min(100, next));
      if (value > 0) beforeMute = value;
      localUntil = performance.now() + 2000;
      paint();
      if (commit) send();
    };
    const fromPointer = (event: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const t = vertical() ? 1 - (event.clientY - r.top) / r.height : (event.clientX - r.left) / r.width;
      set(Math.round(t * 100));
    };
    track.addEventListener("pointerdown", (event) => { track.setPointerCapture(event.pointerId); fromPointer(event); });
    track.addEventListener("pointermove", (event) => { if (track.hasPointerCapture(event.pointerId)) fromPointer(event); });
    track.addEventListener("wheel", (event) => { event.preventDefault(); const step = Number(ctx.config.step) || 5; set(value + (event.deltaY < 0 || event.deltaX > 0 ? step : -step)); }, { passive: false });
    track.addEventListener("keydown", (event) => {
      const step = Number(ctx.config.step) || 5;
      if (event.key === "ArrowUp" || event.key === "ArrowRight") { set(value + step); event.preventDefault(); }
      if (event.key === "ArrowDown" || event.key === "ArrowLeft") { set(value - step); event.preventDefault(); }
    });
    mute.addEventListener("click", () => set(value > 0 ? 0 : beforeMute));

    function paint(): void {
      const v = Math.round(value);
      root.style.setProperty("--v", String(v / 100));
      label.textContent = `${v}%`;
      label.hidden = !ctx.config.label;
      track.setAttribute("aria-valuenow", String(v));
      mute.replaceChildren(svgIcon(SPEAKER + (v === 0 ? MUTED : WAVES)));
      mute.title = v === 0 ? "Включить звук" : "Выключить звук";
      root.classList.toggle("w-vol--muted", v === 0);
    }

    return {
      update(next) {
        ctx = next;
        root.dataset.tier = next.tier;
        root.dataset.dir = next.orientation === "portrait" || next.tier === "slim" ? "v" : "h";
        const server = next.data.state?.audio.volume;
        if (server !== null && server !== undefined && performance.now() > localUntil) { value = server; if (value > 0) beforeMute = value; }
        paint();
      },
      destroy() { window.clearTimeout(sendTimer); },
    };
  },
};
