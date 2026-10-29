//! Runtime configuration from the environment (the init scripts source
//! `$PANEL_DATA_DIR/panel.env`, see deploy/panel.env.example).
//!
//!   PANEL_NAME       display name in the UI and passkey prompts ("Станция")
//!   PANEL_DATA_DIR   state: auth, session, light settings, TLS files
//!   PANEL_WEB_ROOT   static files; <root>/assets/* is served at /assets/*
//!   PANEL_BIND       listen address (0.0.0.0)
//!   PANEL_PORT       listen port (443 with TLS, 8080 without)
//!   PANEL_TLS        auto | on | off (auto: on when cert and key exist)
//!   PANEL_TLS_CERT   PEM chain   (default $PANEL_DATA_DIR/tls/fullchain.pem)
//!   PANEL_TLS_KEY    PEM key     (default $PANEL_DATA_DIR/tls/privkey.pem)
//!   PANEL_AUTH       passkey | password (default: passkey with TLS, else password)
//!   PANEL_PASSWORD   password for PANEL_AUTH=password
//!   PANEL_ORIGIN     https://panel.example.com  (passkey only)
//!   PANEL_RP_ID      panel.example.com          (passkey only, defaults to the ORIGIN host)
const std = @import("std");
const core = @import("core.zig");

pub const AuthMode = enum { passkey, password };

pub const Config = struct {
    name: []const u8,
    data_dir: []const u8,
    web_root: []const u8,
    bind: []const u8,
    port: u16,
    tls: bool,
    tls_cert: []const u8,
    tls_key: []const u8,
    auth: AuthMode,
    password: []const u8,
    origin: []const u8,
    rp_id: []const u8,
    auth_path: []const u8,
    session_path: []const u8,
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

    const auth_text = env("PANEL_AUTH", if (tls) "passkey" else "password");
    const auth = std.meta.stringToEnum(AuthMode, auth_text) orelse {
        std.log.err("PANEL_AUTH must be passkey or password (got \"{s}\")", .{auth_text});
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
    switch (auth) {
        .passkey => {
            if (!tls) std.log.warn("passkeys need HTTPS in the browser: with PANEL_TLS=off only a TLS-terminating reverse proxy works", .{});
            if (origin.len == 0 or rp_id.len == 0) {
                std.log.err("PANEL_AUTH=passkey needs PANEL_ORIGIN (e.g. https://panel.example.com) and optionally PANEL_RP_ID", .{});
                return error.InvalidConfig;
            }
        },
        .password => if (password.len < 8) {
            std.log.err("PANEL_AUTH=password needs PANEL_PASSWORD with at least 8 characters", .{});
            return error.InvalidConfig;
        },
    }
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
        .auth = auth,
        .password = password,
        .origin = origin,
        .rp_id = rp_id,
        .auth_path = join(data_dir, "auth.json"),
        .session_path = join(data_dir, "session"),
        .lights_path = join(data_dir, "lights.json"),
    };
}
