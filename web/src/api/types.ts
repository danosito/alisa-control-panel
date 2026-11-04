// Domain models mirroring the Zig structs served from /api/v1/*.
// Keep field names identical to the JSON contract; map to view models elsewhere.

export interface Metrics {
  cpu_percent: number;
  ram_used_mb: number;
  ram_total_mb: number;
  temp_c: number;
  net_rx_kbps: number;
  net_tx_kbps: number;
}

export interface Health {
  ok: boolean;
  service: string;
  version: string;
}

export interface Capabilities {
  audio: { volume: boolean; analyser: boolean };
  led: { control: boolean; zones: number; modes: boolean };
  microphone: { monitoring: boolean; reason: string };
  media: boolean;
}

export interface AuthStatus {
  /** Any sign-in method exists (otherwise the first visit sets one up). */
  configured: boolean;
  owner: string;
  /** PANEL_NAME: shown in the title and on the login screen. */
  name: string;
  /** Passkeys enabled on the station (PANEL_ORIGIN set). */
  passkey_ready: boolean;
  /** Passkeys only work on exactly this origin. */
  origin: string;
  passkeys: number;
  /** Including PANEL_PASSWORD. */
  passwords: number;
}

export interface RegistrationOptions {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: string; alg: number }>;
  authenticatorSelection: { residentKey: string; userVerification: string };
  attestation: string;
  /** Keys already registered: the authenticator will not create a duplicate. */
  excludeCredentials?: Array<{ type: string; id: string }>;
}

export interface BluetoothDevice {
  address: string;
  name: string;
  paired: boolean;
  connected: boolean;
  trusted: boolean;
  /** BlueZ icon name: "phone", "computer", "audio-headphones", … */
  icon: string;
}

export interface LoginOptions {
  challenge: string;
  rpId: string;
  userVerification: string;
}

export interface SessionResponse {
  ok: boolean;
  session: string;
}

/** A way to sign in: a passkey or a password, usually one per device. */
export interface CredentialInfo {
  id: string;
  type: "passkey" | "password";
  name: string;
  /** Passkey: password manager by AAGUID ("iCloud Keychain"); password: "panel.env" for PANEL_PASSWORD. */
  provider: string;
  created_s: number;
  last_used_s: number;
  /** Signed-in browsers that use it. */
  sessions: number;
  /** The one this browser signed in with. */
  current: boolean;
  removable: boolean;
}

/** A signed-in browser. */
export interface SessionInfo {
  id: string;
  label: string;
  /** Name of the passkey or password it signed in with. */
  credential: string;
  created_s: number;
  last_seen_s: number;
  current: boolean;
}

export interface InviteInfo { code: string; expires_in_s: number }

export interface AuthDevices {
  ok: boolean;
  passkey_ready: boolean;
  owner: string;
  credentials: CredentialInfo[];
  sessions: SessionInfo[];
  invite: InviteInfo | null;
  /** Server clock, for "5 мин назад" without trusting this device's clock. */
  now_s: number;
}

export type LightMode = "off" | "static" | "breathe" | "rainbow" | "candle" | "music";
export type LightAlgo = "pulse" | "spectrum" | "beat" | "flow";

export interface LedState {
  mode: LightMode;
  algo: LightAlgo;
  color: { r: number; g: number; b: number; brightness: number };
  speed: number;
  sensitivity: number;
}

/** AVRCP "now playing" of the connected Bluetooth source. */
export interface MediaState {
  available: boolean;
  status: "playing" | "paused" | "stopped" | "forward-seek" | "reverse-seek" | "error" | (string & {});
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  position_ms: number;
  device: string;
  address: string;
  streaming: boolean;
}

export interface SystemInfo {
  uptime_s: number;
  load: [number, number, number];
  temp_c: number;
  wifi_rssi: number;
  wifi_quality: number;
  disk_free_mb: number;
  disk_total_mb: number;
}

export interface PanelState {
  alice: { running: boolean };
  panel: { running: boolean };
  audio: { volume: number | null };
  led: LedState;
  microphone: { stream: string };
  bluetooth: { name: string; pairing: boolean; discoverable: boolean };
}

export interface DashboardSnapshot {
  health: Health;
  capabilities: Capabilities;
  state: PanelState;
  metrics: Metrics;
  metrics_history: Metrics[];
  bluetooth_devices: BluetoothDevice[];
  media: MediaState;
  system: SystemInfo;
  /** Revision of the shared layout (GET /layout when it changes). */
  layout_revision?: number;
}

/** Body returned with a non-2xx status, e.g. 501 adapter_pending. */
export interface ApiErrorBody {
  ok: false;
  error: string;
  message: string;
}

/** Error codes the backend is known to emit. Extend as the adapter grows. */
export type ApiErrorCode = "adapter_pending" | (string & {});
