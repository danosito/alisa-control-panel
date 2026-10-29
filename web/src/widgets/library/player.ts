import type { MediaAction } from "../../api/client";
import { COVERS_KEY } from "../../api/storage";
import type { MediaState } from "../../api/types";
import { h, svgIcon } from "../../ui/dom";
import { animationLoop, createSurface } from "../canvas";
import type { WidgetContext, WidgetDefinition } from "../types";

type Config = { covers: boolean; timeline: boolean; source: boolean; background: boolean };

const ICONS = {
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  next: '<path d="M6 6v12l8.5-6z" fill="currentColor" stroke="none"/><rect x="16" y="6" width="2.4" height="12" rx="1" fill="currentColor" stroke="none"/>',
  previous: '<path d="M18 6v12L9.5 12z" fill="currentColor" stroke="none"/><rect x="5.6" y="6" width="2.4" height="12" rx="1" fill="currentColor" stroke="none"/>',
  computer: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16.5V20"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  note: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
};

// ---------- cover art: iTunes Search API (CORS-enabled), cached in localStorage ----------
const COVER_KEY = COVERS_KEY;
const coverCache: Record<string, string> = (() => { try { return JSON.parse(localStorage.getItem(COVER_KEY) ?? "{}") as Record<string, string>; } catch { return {}; } })();
const inflight = new Map<string, Promise<string>>();

function findCover(artist: string, title: string, album: string): Promise<string> {
  const key = `${artist}|${album || title}`.toLowerCase();
  if (key in coverCache) return Promise.resolve(coverCache[key]!);
  const pending = inflight.get(key);
  if (pending) return pending;
  const params = new URLSearchParams({ term: `${artist} ${album || title}`, media: "music", entity: album ? "album" : "song", limit: "1" });
  const request = fetch(`https://itunes.apple.com/search?${params}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((json: { results?: Array<{ artworkUrl100?: string }> } | null) => json?.results?.[0]?.artworkUrl100?.replace("100x100bb", "600x600bb") ?? "")
    .catch(() => "")
    .then((url) => {
      coverCache[key] = url;
      const keys = Object.keys(coverCache);
      if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete coverCache[k];
      try { localStorage.setItem(COVER_KEY, JSON.stringify(coverCache)); } catch { /* quota */ }
      inflight.delete(key);
      return url;
    });
  inflight.set(key, request);
  return request;
}

/** Saturated average colour of an image (for the accent). */
function accentOf(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas"); canvas.width = 12; canvas.height = 12;
    const c = canvas.getContext("2d", { willReadFrequently: true })!;
    c.drawImage(img, 0, 0, 12, 12);
    const d = c.getImageData(0, 0, 12, 12).data;
    let r = 0, g = 0, b = 0, wsum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i]!, d[i + 1]!, d[i + 2]!), min = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
      const w = (max - min) / 255 + 0.05; // favour saturated pixels
      r += d[i]! * w; g += d[i + 1]! * w; b += d[i + 2]! * w; wsum += w;
    }
    r /= wsum; g /= wsum; b /= wsum;
    // Lift dark colours so the accent stays readable on the dark card.
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const k = lum < 110 ? 110 / Math.max(lum, 1) : 1;
    return `rgb(${Math.min(255, Math.round(r * k))} ${Math.min(255, Math.round(g * k))} ${Math.min(255, Math.round(b * k))})`;
  } catch { return null; }
}

const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export const playerWidget: WidgetDefinition<Config> = {
  id: "player",
  title: "Плеер",
  description: "Что играет по Bluetooth: обложка, источник, управление и таймлайн",
  category: "Музыка",
  sizes: [{ w: 32, h: 16 }, { w: 16, h: 16 }, { w: 24, h: 28 }, { w: 16, h: 4 }, { w: 8, h: 24 }, { w: 48, h: 16 }],
  minSize: { w: 6, h: 3 },
  maxSize: { w: 64, h: 48 },
  aspect: [0.3, 12],
  defaultConfig: { covers: true, timeline: true, source: true, background: true },
  configSchema: [
    { key: "covers", label: "Искать обложки (iTunes)", type: "checkbox" },
    { key: "background", label: "Размытая обложка фоном", type: "checkbox" },
    { key: "timeline", label: "Таймлайн", type: "checkbox" },
    { key: "source", label: "Показывать устройство-источник", type: "checkbox" },
  ],
  sync: () => ({ kind: "dashboard", intervalMs: 5000 }),
  mount(host, initial) {
    let ctx: WidgetContext<Config> = initial;
    let media: MediaState | null = null;
    let base = { position: 0, at: performance.now() };
    let pendingStatus: { status: string; until: number } | null = null;
    let coverUrl = "";
    let coverFor = "";

    const art = h("div", { class: "w-player__art" }, svgIcon(ICONS.note));
    const img = h("img", { class: "w-player__img", alt: "", decoding: "async", draggable: "false", crossorigin: "anonymous" }) as HTMLImageElement;
    const bg = h("div", { class: "w-player__bg" });
    const title = h("strong", { class: "w-player__title" });
    const artist = h("span", { class: "w-player__artist" });
    const sourceIcon = h("span", { class: "w-player__source-icon" });
    const sourceName = h("span", { class: "w-player__source-name" });
    const source = h("div", { class: "w-player__source" }, sourceIcon, sourceName);
    const elapsed = h("span", { class: "w-player__time" });
    const total = h("span", { class: "w-player__time" });
    const wave = h("div", { class: "w-player__wave" });
    const timeline = h("div", { class: "w-player__timeline" }, wave, h("div", { class: "w-player__times" }, elapsed, total));
    const button = (action: MediaAction | "toggle", label: string, cls = "") => h("button", { class: `w-player__btn ${cls}`, type: "button", "aria-label": label, title: label }) as HTMLButtonElement;
    const prev = button("previous", "Предыдущий"), toggle = button("toggle", "Пауза / воспроизведение", "w-player__btn--main"), next = button("next", "Следующий");
    prev.append(svgIcon(ICONS.previous)); next.append(svgIcon(ICONS.next));
    const controls = h("div", { class: "w-player__controls" }, prev, toggle, next);
    const meta = h("div", { class: "w-player__meta" }, title, artist);
    const body = h("div", { class: "w-player__body" }, source, meta, timeline, controls);
    art.append(img);
    const root = h("div", { class: "w w-player" }, bg, art, body);
    host.append(root);

    // ---------- wavy (Material 3 / Android 13) progress ----------
    const surface = createSurface(wave, () => drawWave(0));
    let amp = 0, phase = 0;
    const playing = () => (pendingStatus && pendingStatus.until > performance.now() ? pendingStatus.status : media?.status) === "playing";
    const position = () => {
      if (!media) return 0;
      const p = base.position + (playing() ? performance.now() - base.at : 0);
      return media.duration_ms ? Math.min(p, media.duration_ms) : p;
    };
    function drawWave(dt: number): boolean {
      const { ctx: g, width: W, height: H } = surface;
      const accent = getComputedStyle(root).getPropertyValue("--accent").trim() || "#c084fc";
      const dur = media?.duration_ms ?? 0;
      const p = dur ? Math.max(0, Math.min(1, position() / dur)) : 0;
      const target = playing() ? Math.min(3.2, H / 5) : 0;
      amp += (target - amp) * Math.min(1, dt * 6);
      if (playing()) phase += dt * 5.5;
      g.clearRect(0, 0, W, H);
      const mid = H / 2, pad = 4, x1 = pad + (W - pad * 2) * p;
      g.lineCap = "round";
      g.lineWidth = 3;
      g.strokeStyle = "rgba(255,255,255,.22)";
      g.beginPath(); g.moveTo(Math.min(W - pad, x1 + 6), mid); g.lineTo(W - pad, mid); g.stroke();
      g.strokeStyle = accent;
      g.beginPath();
      const wavelength = 22;
      for (let x = pad; x <= x1; x += 1.5) {
        const y = mid + Math.sin((x / wavelength) * Math.PI * 2 - phase) * amp;
        if (x === pad) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      // Thumb: a vertical pill, like the M3 slider handle.
      g.fillStyle = accent;
      g.beginPath(); g.roundRect(x1 - 2, mid - Math.min(9, H / 2 - 1), 4, Math.min(18, H - 2), 2); g.fill();
      elapsed.textContent = media?.available ? fmt(position()) : "";
      total.textContent = media?.available && dur ? `-${fmt(dur - position())}` : "";
      return playing() || Math.abs(amp) > 0.05;
    }
    const loop = animationLoop(wave, (dt) => drawWave(dt));

    let lastRawPosition = -1;
    const setMedia = (next: MediaState | null) => {
      const changedTrack = !media || !next || next.title !== media.title || next.artist !== media.artist;
      // BlueZ updates Position only when the source sends AVRCP position events;
      // an unchanged value while playing means "no news", keep interpolating.
      const resync = changedTrack || !next || next.status !== media?.status || next.position_ms !== lastRawPosition;
      media = next;
      lastRawPosition = next?.position_ms ?? -1;
      if (resync) base = { position: next?.position_ms ?? 0, at: performance.now() };
      if (pendingStatus && next && next.status === pendingStatus.status) pendingStatus = null;
      render(changedTrack);
    };

    const act = async (action: MediaAction) => {
      if (ctx.preview || !media?.available) return;
      if (action === "play" || action === "pause") {
        pendingStatus = { status: action === "play" ? "playing" : "paused", until: performance.now() + 2500 };
        base = { position: position(), at: performance.now() };
        render(false);
      }
      try { await ctx.api.media(action); } catch { pendingStatus = null; render(false); }
      ctx.refresh();
    };
    prev.addEventListener("click", () => void act("previous"));
    next.addEventListener("click", () => void act("next"));
    toggle.addEventListener("click", () => void act(playing() ? "pause" : "play"));

    function loadCover(): void {
      const m = media;
      const key = m?.available && m.artist && m.title ? `${m.artist}|${m.album || m.title}` : "";
      if (key === coverFor) return;
      coverFor = key;
      coverUrl = "";
      root.classList.remove("w-player--cover");
      root.style.removeProperty("--accent");
      img.removeAttribute("src");
      bg.style.backgroundImage = "";
      if (!key || !ctx.config.covers) return;
      void findCover(m!.artist, m!.title, m!.album).then((url) => {
        if (coverFor !== key || !url) return;
        coverUrl = url;
        img.src = url;
      });
    }
    img.addEventListener("load", () => {
      root.classList.add("w-player--cover");
      if (ctx.config.background) bg.style.backgroundImage = `url("${coverUrl}")`;
      const accent = accentOf(img);
      if (accent) root.style.setProperty("--accent", accent);
      loop.start();
    });

    function render(trackChanged: boolean): void {
      const m = media;
      const available = Boolean(m?.available);
      root.dataset.state = available ? (playing() ? "playing" : "paused") : m?.streaming ? "streaming" : "idle";
      // Some sources (macOS) report play state but never send the track over
      // AVRCP: say where the sound comes from instead of an empty title.
      const hasTrack = available && Boolean(m!.title);
      const fromSource = (available || m?.streaming) && !hasTrack;
      title.textContent = hasTrack ? m!.title : fromSource ? (m?.device ? `Играет с ${m.device}` : "Играет по Bluetooth") : "Ничего не играет";
      artist.textContent = hasTrack ? [m!.artist, m!.album].filter(Boolean).join(" — ") : fromSource ? "источник не передаёт название трека" : "Подключите телефон или ПК по Bluetooth";
      const device = m?.device ?? "";
      source.hidden = !ctx.config.source || !device;
      sourceName.textContent = device;
      const icon = ctx.data.devices.find((d) => d.address === m?.address)?.icon ?? "";
      sourceIcon.replaceChildren(svgIcon(icon.includes("phone") ? ICONS.phone : ICONS.computer));
      toggle.replaceChildren(svgIcon(playing() ? ICONS.pause : ICONS.play));
      for (const b of [prev, toggle, next]) b.disabled = !available;
      timeline.hidden = !ctx.config.timeline || !available || !m!.duration_ms;
      if (trackChanged) loadCover();
      loop.start();
    }

    const unsubscribe = ctx.live.subscribe({ media: true }, { media: (m) => setMedia(m) });

    const layout = (c: WidgetContext<Config>) => {
      const row = c.tier === "tiny" || c.tier === "wide" || (c.tier === "compact" && c.orientation === "landscape") || (c.tier === "large" && c.orientation === "landscape");
      root.dataset.layout = c.tier === "slim" ? "slim" : row ? "row" : "column";
      root.dataset.tier = c.tier;
      root.classList.toggle("w-player--bg", c.config.background);
    };

    return {
      update(nextCtx) {
        const prevConfig = ctx.config;
        ctx = nextCtx;
        layout(nextCtx);
        if (prevConfig.covers !== nextCtx.config.covers || prevConfig.background !== nextCtx.config.background) coverFor = "__reload__";
        // Dashboard polling is the fallback; live media events are preferred when fresher.
        const incoming = nextCtx.data.media;
        if (incoming && (!media || JSON.stringify(incoming) !== JSON.stringify(media))) setMedia(incoming);
        else render(coverFor === "__reload__");
      },
      destroy() { unsubscribe(); loop.destroy(); surface.destroy(); },
    };
  },
};
