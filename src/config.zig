//! Runtime configuration from the environment (the init scripts source
//! `$PANEL_DATA_DIR/panel.env`, see deploy/panel.env.example).
//!
//!   PANEL_NAME       display name in the UI and passkey prompts ("Станция")
//!   PANEL_DATA_DIR   state: passkeys, sessions, shared layout, light settings, TLS files
//!   PANEL_WEB_ROOT   static files; <root>/assets/* is served at /assets/*
//!   PANEL_BIND       listen address (0.0.0.0)
//!   PANEL_PORT       listen port (443 with TLS, 8080 without)
//!   PANEL_TLS        auto | on | off (auto: on when cert and key exist)
//!   PANEL_TLS_CERT   PEM chain   (default $PANEL_DATA_DIR/tls/fullchain.pem)
//!   PANEL_TLS_KEY    PEM key     (default $PANEL_DATA_DIR/tls/privkey.pem)
//!   PANEL_PASSWORD   optional station password (always accepted, managed here);
//!                    more passwords and passkeys are added in the web UI
//!   PANEL_ORIGIN     https://panel.example.com  enables passkeys (they only
//!                    work on this exact origin)
//!   PANEL_RP_ID      panel.example.com          (defaults to the ORIGIN host)
//!   PANEL_AUTH       legacy: "password" turns passkeys off
const std = @import("std");
const core = @import("core.zig");

pub const AuthMode = enum { passkey, password, any };

pub const Config = struct {
    name: []const u8,
    data_dir: []const u8,
    web_root: []const u8,
    bind: []const u8,
    port: u16,
    tls: bool,
    tls_cert: []const u8,
    tls_key: []const u8,
    /// Passkeys usable (PANEL_ORIGIN set); passwords always are.
    passkeys: bool,
    password: []const u8,
    origin: []const u8,
    rp_id: []const u8,
    auth_path: []const u8,
    /// Pre-0.5 single session token, migrated into sessions.json.
    session_path: []const u8,
    sessions_path: []const u8,
    layout_path: []const u8,
    lights_path: []const u8,
};

fn env(name: []const u8, fallback: []const u8) []const u8 {
    const value = std.posix.getenv(name) orelse return fallback;
    const trimmed = std.mem.trim(u8, value, " \t\r\n");
    return if (trimmed.len == 0) fallback else trimmed;
}

fn join(dir: []const u8, file: []const u8) []const u8 {
    return std.fs.path.join(core.allocator, &.{ dir, file }) catch @panic("out of memory");
}

fn exists(path: []const u8) bool {
    std.fs.accessAbsolute(path, .{}) catch return false;
    return true;
}

/// Reads and validates the configuration; returns an error with a log line
/// explaining what to fix instead of starting half-configured.
pub fn load() !Config {
    const data_dir = env("PANEL_DATA_DIR", "/data/opt/etc/alisa-panel");
    const tls_cert = env("PANEL_TLS_CERT", join(data_dir, "tls/fullchain.pem"));
    const tls_key = env("PANEL_TLS_KEY", join(data_dir, "tls/privkey.pem"));
    const tls_mode = env("PANEL_TLS", "auto");
    const tls = if (std.mem.eql(u8, tls_mode, "on"))
        true
    else if (std.mem.eql(u8, tls_mode, "off"))
        false
    else if (std.mem.eql(u8, tls_mode, "auto"))
        exists(tls_cert) and exists(tls_key)
    else {
        std.log.err("PANEL_TLS must be auto, on or off (got \"{s}\")", .{tls_mode});
        return error.InvalidConfig;
    };

    const auth_text = env("PANEL_AUTH", "any");
    const auth = std.meta.stringToEnum(AuthMode, auth_text) orelse {
        std.log.err("PANEL_AUTH must be any, passkey or password (got \"{s}\")", .{auth_text});
        return error.InvalidConfig;
    };
    const origin = env("PANEL_ORIGIN", "");
    var rp_id = env("PANEL_RP_ID", "");
    if (rp_id.len == 0 and origin.len > 0) {
        if (std.Uri.parse(origin)) |uri| {
            if (uri.host) |host| rp_id = switch (host) {
                .raw, .percent_encoded => |h| h,
            };
        } else |_| {}
    }
    const password = env("PANEL_PASSWORD", "");
    if (password.len > 0 and password.len < 8) {
        std.log.err("PANEL_PASSWORD needs at least 8 characters", .{});
        return error.InvalidConfig;
    }
    const passkeys = auth != .password and origin.len > 0 and rp_id.len > 0;
    if (auth == .passkey and !passkeys) {
        std.log.err("PANEL_AUTH=passkey needs PANEL_ORIGIN (e.g. https://panel.example.com)", .{});
        return error.InvalidConfig;
    }
    if (passkeys and !tls and !std.mem.startsWith(u8, origin, "http://localhost")) std.log.warn("passkeys need HTTPS in the browser: with PANEL_TLS=off only a TLS-terminating reverse proxy works", .{});
    const port_text = env("PANEL_PORT", if (tls) "443" else "8080");
    const port = std.fmt.parseInt(u16, port_text, 10) catch {
        std.log.err("PANEL_PORT is not a port number: \"{s}\"", .{port_text});
        return error.InvalidConfig;
    };
    return .{
        .name = env("PANEL_NAME", "Станция"),
        .data_dir = data_dir,
        .web_root = env("PANEL_WEB_ROOT", "/data/opt/share/alisa-panel"),
        .bind = env("PANEL_BIND", "0.0.0.0"),
        .port = port,
        .tls = tls,
        .tls_cert = tls_cert,
        .tls_key = tls_key,
        .passkeys = passkeys,
        .password = password,
        .origin = origin,
        .rp_id = rp_id,
        .auth_path = join(data_dir, "auth.json"),
        .session_path = join(data_dir, "session"),
        .sessions_path = join(data_dir, "sessions.json"),
        .layout_path = join(data_dir, "layout.json"),
        .lights_path = join(data_dir, "lights.json"),
    };
}
