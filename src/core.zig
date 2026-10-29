const std = @import("std");

/// libc malloc: page_allocator burned a whole 4 KiB page per small allocation.
pub const allocator = std.heap.c_allocator;
/// Runtime configuration, set once in main before any thread starts.
pub var config: @import("config.zig").Config = undefined;

pub const Health = struct { ok: bool, service: []const u8, version: []const u8 };
pub const ApiError = struct { ok: bool, @"error": []const u8, message: []const u8 };
pub const AudioCapabilities = struct { volume: bool, analyser: bool };
pub const LedCapabilities = struct { control: bool, zones: u8, modes: bool };
pub const MicrophoneCapabilities = struct { monitoring: bool, reason: []const u8 };
pub const Capabilities = struct { audio: AudioCapabilities, led: LedCapabilities, microphone: MicrophoneCapabilities, media: bool };
pub const AliceState = struct { running: bool };
pub const AudioState = struct { volume: ?u8 };
pub const LedColor = struct { r: u8, g: u8, b: u8, brightness: u8 };
pub const LedState = struct { mode: []const u8, algo: []const u8, color: LedColor, speed: u8, sensitivity: u8 };
pub const MicState = struct { stream: []const u8 };
pub const PanelState = struct { running: bool };
pub const BluetoothState = struct { name: []const u8, pairing: bool, discoverable: bool };
pub const State = struct { alice: AliceState, panel: PanelState, audio: AudioState, led: LedState, microphone: MicState, bluetooth: BluetoothState };

/// One history sample per second.
pub const Metrics = struct { cpu_percent: f32, ram_used_mb: u32, ram_total_mb: u32, temp_c: f32 = 0, net_rx_kbps: f32 = 0, net_tx_kbps: f32 = 0 };
/// Slow-changing system facts, refreshed by the sampler.
pub const SystemInfo = struct { uptime_s: u64 = 0, load: [3]f32 = .{ 0, 0, 0 }, temp_c: f32 = 0, wifi_rssi: i32 = 0, wifi_quality: u8 = 0, disk_free_mb: u32 = 0, disk_total_mb: u32 = 0 };

/// AVRCP "now playing" from the connected phone/PC (org.bluez.MediaPlayer1).
pub const MediaState = struct {
    available: bool = false,
    status: []const u8 = "stopped",
    title: []const u8 = "",
    artist: []const u8 = "",
    album: []const u8 = "",
    duration_ms: u32 = 0,
    position_ms: u32 = 0,
    /// Name and address of the device the music comes from.
    device: []const u8 = "",
    address: []const u8 = "",
    /// The A2DP transport is active (audio is actually flowing).
    streaming: bool = false,
};

pub const Credential = struct { credential_id: []const u8, public_key: []const u8, sign_count: u32 };
pub const AuthStore = struct { owner: []const u8 = "", credential: ?Credential = null };
pub const AuthStatus = struct { configured: bool, owner: []const u8, passkeys: u8, mode: []const u8, name: []const u8 };
pub const PasswordLoginInput = struct { password: []const u8 };
pub const SessionResponse = struct { ok: bool, session: []const u8 };
pub const SessionStatus = struct { ok: bool, authenticated: bool };
pub const PublicKeyParam = struct { type: []const u8, alg: i32 };
pub const RelyingParty = struct { name: []const u8, id: []const u8 };
pub const UserEntity = struct { id: []const u8, name: []const u8, displayName: []const u8 };
pub const RegistrationOptions = struct { challenge: []const u8, rp: RelyingParty, user: UserEntity, pubKeyCredParams: []const PublicKeyParam, authenticatorSelection: struct { residentKey: []const u8, userVerification: []const u8 }, attestation: []const u8 };
pub const LoginOptions = struct { challenge: []const u8, rpId: []const u8, userVerification: []const u8 };
pub const RegistrationInput = struct { owner: []const u8, attestationObject: []const u8, clientDataJSON: []const u8 };
pub const LoginInput = struct { credentialId: []const u8, authenticatorData: []const u8, clientDataJSON: []const u8, signature: []const u8 };
pub const LedInput = struct { r: u8, g: u8, b: u8, brightness: u8 = 255 };
pub const LedModeInput = struct { mode: ?[]const u8 = null, algo: ?[]const u8 = null, r: ?u8 = null, g: ?u8 = null, b: ?u8 = null, brightness: ?u8 = null, speed: ?u8 = null, sensitivity: ?u8 = null };
pub const VolumeInput = struct { volume: u8 };
pub const BluetoothAction = struct { address: []const u8 };
pub const BluetoothDevice = struct { address: []const u8, name: []const u8, paired: bool, connected: bool, trusted: bool = false, icon: []const u8 = "" };
pub const DashboardSnapshot = struct { health: Health, capabilities: Capabilities, state: State, metrics: Metrics, metrics_history: []const Metrics, bluetooth_devices: []const BluetoothDevice, media: MediaState, system: SystemInfo };

pub const Context = struct {
    mutex: std.Thread.Mutex = .{},
    auth_store: AuthStore = .{},
    pending_challenge: ?[]const u8 = null,
    session_token: ?[]const u8 = null,
    previous_cpu_total: u64 = 0,
    previous_cpu_idle: u64 = 0,
    previous_net: struct { rx: u64 = 0, tx: u64 = 0, ms: i64 = 0 } = .{},
    metrics_history: [120]Metrics = undefined,
    metrics_history_len: usize = 0,
    metrics_history_next: usize = 0,
    system: SystemInfo = .{},
    /// Master volume 0..100 (softvol "Master Playback Volume"), null until read.
    volume: ?u8 = null,
    /// Latest BlueZ snapshot (bluez.Snapshot); owned, swapped by the sampler.
    bluez: @import("bluez.zig").Snapshot = .{},
    bluez_fetched_ms: i64 = 0,
    /// Set once in main before any thread starts.
    hub: *@import("audio.zig").Hub = undefined,
    lights: *@import("lights.zig").Engine = undefined,
    /// Bumped whenever the media state changes meaningfully (live socket push).
    media_seq: std.atomic.Value(u32) = .init(0),
    /// Live sockets subscribed to media events; >0 keeps BlueZ polling at 1 Hz.
    media_subscribers: std.atomic.Value(u32) = .init(0),
    /// Last /dashboard request (unix seconds; 32-bit ARM has no 64-bit
    /// atomics). Recent requests keep BlueZ polling at 1 Hz.
    last_dashboard_s: std.atomic.Value(u32) = .init(0),
    /// Failed password logins (brute-force throttle, see auth.passwordLogin).
    failed_logins: u32 = 0,
    failed_login_s: i64 = 0,
    /// Wakes the sampler early (after a Bluetooth/media action).
    refresh_requested: std.atomic.Value(bool) = .init(false),
};
