// One WebSocket per tab for real-time data (/api/v1/live/ws), shared by every
// widget. Widgets subscribe to topics; the socket asks the server only for
// the union of what mounted widgets need, so audio capture on the speaker runs
// only while something on screen uses it.
import { wsProtocols } from "./storage";
import type { MediaState } from "./types";

export type LiveSource = "playback" | "mic";

/** Decoded analyser frame (layout: src/audio.zig). */
export interface LiveFrame {
  source: LiveSource;
  beat: boolean;
  /** dBFS, -90..0 */
  levelDb: number;
  peakDb: number;
  /** 0..1, auto-gain */
  level: number;
  bass: number;
  mid: number;
  treble: number;
  /** Raw mic channels, dBFS (mic source only). */
  micDb: [number, number];
  /** 0..1 per band, low to high frequency. */
  bands: Float32Array;
  /** -1..1 waveform of the last ~43 ms. */
  wave: Float32Array;
  receivedAt: number;
}

export interface LiveTopics { playback?: boolean; mic?: boolean; media?: boolean }
export interface LiveHandlers { frame?(frame: LiveFrame): void; media?(media: MediaState): void; status?(connected: boolean): void }

export interface LiveClient {
  subscribe(topics: LiveTopics, handlers: LiveHandlers): () => void;
  readonly connected: boolean;
}

const dbOf = (byte: number) => (byte / 255) * 90 - 90;

export function decodeFrame(data: ArrayBuffer): LiveFrame | null {
  const b = new Uint8Array(data);
  if (b.length < 12 || b[0] !== 1) return null;
  const bandCount = b[3]!;
  const waveStart = 12 + bandCount;
  const bands = new Float32Array(bandCount);
  for (let i = 0; i < bandCount; i++) bands[i] = b[12 + i]! / 255;
  const raw = new Int8Array(data, waveStart, b.length - waveStart);
  const wave = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) wave[i] = raw[i]! / 127;
  return {
    source: b[1] === 1 ? "mic" : "playback", beat: (b[2]! & 1) === 1,
    levelDb: dbOf(b[4]!), peakDb: dbOf(b[5]!), bass: b[6]! / 255, mid: b[7]! / 255, treble: b[8]! / 255,
    micDb: [dbOf(b[9]!), dbOf(b[10]!)], level: b[11]! / 255, bands, wave, receivedAt: performance.now(),
  };
}

interface Entry { topics: LiveTopics; handlers: LiveHandlers }

export function createLiveClient(): LiveClient {
  const entries = new Set<Entry>();
  let socket: WebSocket | null = null;
  let connected = false;
  let retry = 0;
  let retryTimer: number | undefined;
  let closeTimer: number | undefined;
  let sent = "";

  const union = (): Required<LiveTopics> => {
    const u = { playback: false, mic: false, media: false };
    for (const e of entries) { u.playback ||= !!e.topics.playback; u.mic ||= !!e.topics.mic; u.media ||= !!e.topics.media; }
    return u;
  };
  const sendTopics = () => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify({ type: "subscribe", ...union() });
    if (message === sent) return;
    sent = message;
    socket.send(message);
  };
  const setConnected = (value: boolean) => { connected = value; for (const e of entries) e.handlers.status?.(value); };

  function open(): void {
    window.clearTimeout(retryTimer);
    if (socket || entries.size === 0 || document.visibilityState === "hidden") return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/live/ws`, wsProtocols());
    ws.binaryType = "arraybuffer";
    socket = ws;
    sent = "";
    ws.onopen = () => { retry = 0; setConnected(true); sendTopics(); };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as { type: string; media?: MediaState };
          if (message.type === "media" && message.media) for (const e of entries) if (e.topics.media) e.handlers.media?.(message.media);
        } catch { /* ignore malformed */ }
        return;
      }
      const frame = decodeFrame(event.data as ArrayBuffer);
      if (!frame) return;
      for (const e of entries) if (e.topics[frame.source]) e.handlers.frame?.(frame);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      setConnected(false);
      if (entries.size === 0) return;
      retry = Math.min(retry + 1, 6);
      retryTimer = window.setTimeout(open, 400 * 2 ** retry);
    };
  }

  // Background tabs must not keep the speaker capturing audio.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { window.clearTimeout(retryTimer); socket?.close(); socket = null; }
    else open();
  });

  return {
    get connected() { return connected; },
    subscribe(topics, handlers) {
      const entry: Entry = { topics, handlers };
      entries.add(entry);
      window.clearTimeout(closeTimer);
      if (socket) sendTopics(); else if (document.visibilityState === "visible") open();
      handlers.status?.(connected);
      return () => {
        entries.delete(entry);
        sendTopics();
        // Keep the socket briefly so screen switches do not reconnect.
        window.clearTimeout(closeTimer);
        if (entries.size === 0) closeTimer = window.setTimeout(() => { if (entries.size === 0) { socket?.close(); socket = null; } }, 4000);
      };
    },
  };
}

/** Synthetic frames for catalog previews and the widget kit. */
export function createFakeLiveClient(): LiveClient {
  return {
    connected: true,
    subscribe(topics, handlers) {
      handlers.status?.(true);
      const started = performance.now();
      const timer = window.setInterval(() => {
        const t = (performance.now() - started) / 1000;
        for (const source of ["playback", "mic"] as const) {
          if (!topics[source]) continue;
          const beatPhase = (t * 2.1) % 1;
          const bands = new Float32Array(48).map((_, i) => Math.max(0, Math.min(1, 0.75 - i / 80 + 0.25 * Math.sin(t * 3 + i / 3) + (i < 10 ? 0.4 * Math.exp(-beatPhase * 6) : 0) - (source === "mic" ? 0.35 : 0))));
          const wave = new Float32Array(128).map((_, i) => 0.7 * Math.sin(i / 5 + t * 9) * Math.sin(i / 40 + t));
          const level = source === "mic" ? 0.35 + 0.2 * Math.sin(t * 2) : 0.6 + 0.35 * Math.exp(-beatPhase * 5);
          handlers.frame?.({ source, beat: beatPhase < 0.05, levelDb: -40 + level * 30, peakDb: -30 + level * 25, level, bass: bands[4]!, mid: bands[24]!, treble: bands[42]!, micDb: [-52 + 8 * Math.sin(t * 2), -54 + 8 * Math.cos(t * 1.7)], bands, wave, receivedAt: performance.now() });
        }
      }, 1000 / 30);
      return () => window.clearInterval(timer);
    },
  };
}
