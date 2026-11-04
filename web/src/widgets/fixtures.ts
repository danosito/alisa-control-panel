// Fake data for the widget kit and catalog previews.
import type { ApiClient } from "../api/client";
import { createFakeLiveClient, type LiveClient } from "../api/live";
import type { DashboardSnapshot, Metrics } from "../api/types";
import type { DataSnapshot } from "./types";

function fakeHistory(): Metrics[] {
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5; // deterministic
  let cpu = 16;
  return Array.from({ length: 120 }, (_, i) => ({
    cpu_percent: (cpu = Math.min(80, Math.max(4, cpu + noise() * 10 + (i % 37 === 0 ? 30 : 0) - (cpu - 18) * 0.12))),
    ram_used_mb: 150 + Math.round(12 * Math.sin(i / 19)),
    ram_total_mb: 237,
    temp_c: 50 + 3 * Math.sin(i / 30),
    net_rx_kbps: 300 + 250 * Math.sin(i / 5),
    net_tx_kbps: 40 + 30 * Math.sin(i / 4),
  }));
}

export function fixtureData(): DataSnapshot {
  const history = fakeHistory();
  return {
    capabilities: { audio: { volume: true, analyser: true }, led: { control: true, zones: 3, modes: true }, microphone: { monitoring: true, reason: "pdm_raw" }, media: true },
    state: {
      alice: { running: false }, panel: { running: true }, audio: { volume: 72 },
      led: { mode: "music", algo: "spectrum", color: { r: 168, g: 85, b: 247, brightness: 220 }, speed: 50, sensitivity: 60 },
      microphone: { stream: "pdm" },
      bluetooth: { name: "Станция", pairing: false, discoverable: false },
    },
    metrics: history[history.length - 1]!,
    history,
    devices: [
      { address: "00:11:22:33:44:01", name: "Desktop PC", paired: true, connected: true, trusted: true, icon: "computer" },
      { address: "00:11:22:33:44:02", name: "Android Phone", paired: true, connected: false, trusted: true, icon: "phone" },
    ],
    media: { available: true, status: "playing", title: "Power", artist: "Kanye West", album: "My Beautiful Dark Twisted Fantasy", duration_ms: 301603, position_ms: 112000, device: "Desktop PC", address: "00:11:22:33:44:01", streaming: true },
    system: { uptime_s: 17575, load: [1.57, 1.54, 1.55], temp_c: 51, wifi_rssi: -63, wifi_quality: 67, disk_free_mb: 39, disk_total_mb: 87 },
  };
}

export function fixtureLive(recording?: string): LiveClient { return createFakeLiveClient(recording); }

/** An ApiClient that never touches the network. */
export function fixtureApi(): ApiClient {
  const data = fixtureData();
  const ok = async () => ({ ok: true });
  const dashboard = async (): Promise<DashboardSnapshot> => ({
    health: { ok: true, service: "alisa-panel", version: "kit" },
    capabilities: data.capabilities!, state: data.state!, metrics: data.metrics!, metrics_history: data.history, bluetooth_devices: data.devices, media: data.media!, system: data.system!,
  });
  const now = Math.floor(Date.now() / 1000);
  let invited = false;
  const devices = async () => ({
    ok: true, mode: "passkey", owner: "demo", now_s: now, invite: invited ? { code: "K7Q2MX4D", expires_in_s: 540 } : null,
    passkeys: [
      { id: "mac", name: "MacBook · Chrome", provider: "iCloud Keychain", created_s: now - 9 * 86400, last_used_s: now - 40, sessions: 1, current: true },
      { id: "phone", name: "vivo X200 Pro · Chrome", provider: "Google Password Manager", created_s: now - 2 * 86400, last_used_s: now - 3 * 3600, sessions: 1, current: false },
    ],
    sessions: [
      { id: "a1", label: "MacBook · Chrome", passkey: "MacBook · Chrome", created_s: now - 9 * 86400, last_seen_s: now, current: true },
      { id: "b2", label: "vivo X200 Pro · Chrome", passkey: "vivo X200 Pro · Chrome", created_s: now - 2 * 86400, last_seen_s: now - 3 * 3600, current: false },
    ],
  });
  const invite = async () => { invited = true; return { ok: true, code: "K7Q2MX4D", expires_in_s: 600 }; };
  return new Proxy({ dashboard, devices, invite }, { get: (target, key) => (key in target ? (target as Record<string, unknown>)[key as string] : ok) }) as unknown as ApiClient;
}
