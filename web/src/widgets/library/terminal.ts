import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { wsProtocols } from "../../api/storage";
import { demoBtop, demoShell } from "./terminalDemo";
import { h } from "../../ui/dom";
import type { WidgetContext, WidgetDefinition } from "../types";

type Config = { shell: string; command: string; fontSize: number; blink: boolean };

const THEME = { background: "#080a0e", foreground: "#d6dde8", cursor: "#c084fc", cursorAccent: "#080a0e", selectionBackground: "#3b2458" };
const encoder = new TextEncoder();

// One widget instance = one WebSocket = one PTY on the backend. The socket is
// opened only once the widget has a real size, so bash starts with the right
// geometry instead of 80×24 followed by a resize.
export const terminalWidget: WidgetDefinition<Config> = {
  id: "terminal",
  title: "Терминал",
  description: "Интерактивный bash (PTY); можно задать стартовую команду, например btop",
  category: "Инструменты",
  sizes: [{ w: 16, h: 16 }, { w: 32, h: 16 }, { w: 32, h: 32 }, { w: 64, h: 24 }],
  minSize: { w: 6, h: 4 },
  maxSize: { w: 64, h: 64 },
  aspect: [0.5, 6],
  defaultConfig: { shell: "bash", command: "", fontSize: 13, blink: true },
  configSchema: [
    { key: "shell", label: "Оболочка", type: "select", options: [{ value: "bash", label: "bash (как в SSH)" }, { value: "sh", label: "busybox sh" }] },
    { key: "command", label: "Команда при запуске", type: "text", placeholder: "например: btop" },
    { key: "fontSize", label: "Размер шрифта", type: "number", min: 9, max: 22, step: 1 },
    { key: "blink", label: "Мигающий курсор", type: "checkbox" },
  ],
  sync: () => ({ kind: "none" }),
  mount(host, initial) {
    let ctx: WidgetContext<Config> = initial;
    const surface = h("div", { class: "w-term__surface" });
    const root = h("div", { class: "w w-term" }, surface);
    host.append(root);

    const term = new Terminal({ cursorBlink: ctx.config.blink, fontSize: ctx.config.fontSize, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", scrollback: 5000, theme: THEME, allowProposedApi: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(surface);

    let socket: WebSocket | null = null;
    let connection: { shell: string; command: string } | null = null;
    let size = { cols: 0, rows: 0 };
    let closedByUs = false;

    const measure = (): boolean => {
      const { width, height } = surface.getBoundingClientRect();
      if (width < 40 || height < 30) return false;
      fit.fit();
      return term.cols > 0 && term.rows > 0;
    };
    const sendResize = () => {
      if (!measure()) return;
      if (term.cols === size.cols && term.rows === size.rows) return;
      size = { cols: term.cols, rows: term.rows };
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
    };
    const send = (data: string) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const bytes = encoder.encode(data);
      for (let i = 0; i < bytes.length; i += 8192) socket.send(bytes.subarray(i, i + 8192));
    };

    const connect = () => {
      if (ctx.preview || !measure()) return;
      disconnect();
      size = { cols: term.cols, rows: term.rows };
      const query = new URLSearchParams({ cols: String(size.cols), rows: String(size.rows), shell: ctx.config.shell });
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/v1/terminal/ws?${query}`, wsProtocols());
      ws.binaryType = "arraybuffer";
      connection = { shell: ctx.config.shell, command: ctx.config.command };
      closedByUs = false;
      ws.onopen = () => {
        // The widget may have been resized while connecting (grid settling):
        // those resizes were not sent, so always push the current geometry.
        size = { cols: 0, rows: 0 };
        sendResize();
        if (ctx.config.command.trim()) send(`${ctx.config.command.trim()}\r`);
      };
      ws.onmessage = (event) => term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
      ws.onclose = () => { if (socket === ws) socket = null; if (!closedByUs) term.write("\r\n\x1b[2m[соединение закрыто — нажмите любую клавишу]\x1b[0m\r\n"); };
      socket = ws;
    };
    function disconnect() { closedByUs = true; socket?.close(); socket = null; }

    term.onData((data) => { if (!socket && !ctx.preview) { term.reset(); connect(); return; } send(data); });

    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { if (ctx.preview) { drawPreview(); return; } if (!socket && !connection) connect(); else sendResize(); }, 60);
    });
    observer.observe(surface);
    // A terminal mounted on an off-screen panel cannot measure its font, so
    // fit() keeps 80x24: refit when it scrolls into view.
    const visibility = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (ctx.preview) drawPreview(); else if (socket) sendResize();
    });
    visibility.observe(surface);

    // Preview/demo: no PTY. Draw a static screen for the current size
    // (redrawn whenever the grid settles on a new size).
    let previewSize = "";
    const drawPreview = () => {
      if (!ctx.preview || !measure()) return;
      const btop = ctx.config.command.trim().startsWith("btop");
      const key = `${term.cols}x${term.rows}:${btop}`;
      if (key === previewSize) return;
      previewSize = key;
      term.reset();
      term.write(btop ? `\x1b[?25l${demoBtop(term.cols, term.rows)}` : demoShell());
    };

    return {
      update(next) {
        const prev = ctx;
        ctx = next;
        if (prev.config.fontSize !== next.config.fontSize) { term.options.fontSize = next.config.fontSize; sendResize(); }
        if (prev.config.blink !== next.config.blink) term.options.cursorBlink = next.config.blink;
        if (connection && (connection.shell !== next.config.shell || connection.command !== next.config.command)) { term.reset(); connect(); }
      },
      destroy() { observer.disconnect(); visibility.disconnect(); window.clearTimeout(resizeTimer); disconnect(); term.dispose(); },
    };
  },
};
