// Shared helpers for canvas-based widgets: DPR-correct sizing, an animation
// loop that runs only while the canvas is visible, and colour schemes.

export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixel size. */
  width: number;
  height: number;
  dpr: number;
  destroy(): void;
}

/** Canvas that tracks its element size; drawing uses CSS pixels. */
export function createSurface(parent: HTMLElement, onResize?: () => void): Surface {
  const canvas = document.createElement("canvas");
  canvas.className = "w-canvas";
  parent.append(canvas);
  const ctx = canvas.getContext("2d")!;
  const surface: Surface = { canvas, ctx, width: 0, height: 0, dpr: 1, destroy: () => observer.disconnect() };
  // The first, synchronous fit must not call back: the widget is still
  // initialising its state. ResizeObserver delivers the first callback.
  let ready = false;
  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (w === surface.width && h === surface.height && dpr === surface.dpr) return;
    surface.width = w; surface.height = h; surface.dpr = dpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ready) onResize?.();
  };
  const observer = new ResizeObserver(() => { ready = true; fit(); onResize?.(); });
  observer.observe(canvas);
  fit();
  return surface;
}

/** requestAnimationFrame loop paused while the element is off-screen or the tab is hidden. */
export function animationLoop(el: Element, frame: (dt: number, now: number) => boolean | void): { start(): void; stop(): void; destroy(): void } {
  let raf = 0, last = 0, visible = true, wanted = false;
  const tick = (now: number) => {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    // A frame callback returning false asks to idle until start() is called.
    if (frame(dt, now) === false) { wanted = false; last = 0; return; }
    schedule();
  };
  const schedule = () => { if (wanted && visible && !raf && document.visibilityState === "visible") raf = requestAnimationFrame(tick); };
  const io = new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); if (!visible) { cancelAnimationFrame(raf); raf = 0; last = 0; } else schedule(); });
  io.observe(el);
  const onVisibility = () => schedule();
  document.addEventListener("visibilitychange", onVisibility);
  return {
    start() { wanted = true; schedule(); },
    stop() { wanted = false; cancelAnimationFrame(raf); raf = 0; last = 0; },
    destroy() { wanted = false; cancelAnimationFrame(raf); io.disconnect(); document.removeEventListener("visibilitychange", onVisibility); },
  };
}

export type Scheme = "accent" | "rainbow" | "fire" | "ice" | "mono" | "led";
export const SCHEME_OPTIONS: Array<{ value: Scheme; label: string }> = [
  { value: "accent", label: "Акцент (фиолетовый)" }, { value: "rainbow", label: "Радуга" }, { value: "fire", label: "Огонь" },
  { value: "ice", label: "Лёд" }, { value: "mono", label: "Монохром" }, { value: "led", label: "Цвет подсветки" },
];

const STOPS: Record<Exclude<Scheme, "rainbow" | "led">, string[]> = {
  accent: ["#67e8f9", "#a855f7", "#f472b6"],
  fire: ["#7f1d1d", "#f97316", "#fde047"],
  ice: ["#1e3a8a", "#38bdf8", "#e0f2fe"],
  mono: ["#6b7280", "#e5e7eb", "#ffffff"],
};

/** Colour at position t (0..1) of a scheme; `led` uses the given RGB. */
export function schemeColor(scheme: Scheme, t: number, led?: { r: number; g: number; b: number }, alpha = 1): string {
  const x = Math.max(0, Math.min(1, t));
  if (scheme === "rainbow") return `hsl(${Math.round(280 - x * 280)} 90% ${55 + x * 10}% / ${alpha})`;
  if (scheme === "led") {
    const c = led && led.r + led.g + led.b > 0 ? led : { r: 168, g: 85, b: 247 };
    const k = 0.45 + 0.55 * x;
    return `rgb(${Math.round(c.r * k + (255 - c.r) * x * 0.25)} ${Math.round(c.g * k + (255 - c.g) * x * 0.25)} ${Math.round(c.b * k + (255 - c.b) * x * 0.25)} / ${alpha})`;
  }
  const stops = STOPS[scheme].map(hexToRgb);
  const pos = x * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(pos)), f = pos - i;
  const a = stops[i]!, b = stops[i + 1]!;
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)} ${Math.round(a[1] + (b[1] - a[1]) * f)} ${Math.round(a[2] + (b[2] - a[2]) * f)} / ${alpha})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Resamples 48 analyser bands into `count` bars (averaging or interpolating). */
export function resample(bands: Float32Array, count: number, out: Float32Array): void {
  const n = bands.length;
  for (let i = 0; i < count; i++) {
    const start = (i * n) / count, end = ((i + 1) * n) / count;
    if (end - start >= 1) {
      let sum = 0, k = 0;
      for (let j = Math.floor(start); j < Math.ceil(end) && j < n; j++) { sum += bands[j]!; k++; }
      out[i] = k ? sum / k : 0;
    } else {
      const p = (start + end) / 2 - 0.5, j = Math.max(0, Math.min(n - 2, Math.floor(p))), f = Math.max(0, Math.min(1, p - j));
      out[i] = bands[j]! * (1 - f) + bands[j + 1]! * f;
    }
  }
}
