// Serves the built ../src/index.html for local preview.
// /api/v1/* is answered by a mock mirroring src/main.zig, or proxied to a real
// panel when PANEL_BACKEND is set (e.g. PANEL_BACKEND=http://192.168.1.50:8080).
// Usage: node scripts/preview.mjs   (PORT defaults to 8080)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexFile = path.resolve(here, "..", "..", "src", "index.html");
const port = Number(process.env.PORT ?? 8080);
const backend = process.env.PANEL_BACKEND?.replace(/\/$/, "");

const mock = {
  "/api/v1/health": { ok: true, service: "alisa-panel", version: "0.1.0" },
  "/api/v1/capabilities": {
    audio: { playback: true, samples: true },
    led: { control: true, zones: 3 },
    microphone: { monitoring: false, reason: "adapter_pending" },
  },
  "/api/v1/state": {
    alice: { running: false },
    panel: { running: true },
    audio: { playing: false, volume: null },
    led: { mode: "firmware" },
    microphone: { stream: "unavailable" },
  },
};

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

async function proxy(req, res) {
  try {
    const upstream = await fetch(`${backend}${req.url}`, { method: req.method, headers: { Accept: "application/json" } });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch (error) {
    json(res, 502, { ok: false, error: "proxy_failed", message: String(error.message ?? error) });
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/" || url === "/index.html") {
    try {
      const html = await readFile(indexFile);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("src/index.html is missing — run `npm run build` first");
    }
    return;
  }
  if (url.startsWith("/api/v1/")) {
    if (backend) return proxy(req, res);
    const body = mock[url];
    if (body) return json(res, 200, body);
    return json(res, 501, { ok: false, error: "adapter_pending", message: "Hardware adapter is not enabled yet" });
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(port, () => {
  console.log(`panel-web: preview at http://localhost:${port} (${backend ? `proxy → ${backend}` : "mock API"})`);
});
