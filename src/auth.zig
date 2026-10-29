const std = @import("std");
const passcay = @import("passcay");
const core = @import("core.zig");

pub fn generateToken() ![]const u8 {
    var raw: [32]u8 = undefined;
    std.crypto.random.bytes(&raw);
    const encoded = try core.allocator.alloc(u8, std.base64.url_safe_no_pad.Encoder.calcSize(raw.len));
    _ = std.base64.url_safe_no_pad.Encoder.encode(encoded, &raw);
    return encoded;
}

/// The browser session survives restarts (deploys) instead of forcing a new
/// login every time. Stored 0600 next to auth.json.
fn persistSession(token: []const u8) void {
    var file = std.fs.createFileAbsolute(core.config.session_path, .{ .truncate = true, .mode = 0o600 }) catch return;
    defer file.close();
    file.writeAll(token) catch {};
}

fn newSession(ctx: *core.Context) ![]const u8 {
    if (ctx.session_token) |old| core.allocator.free(old);
    ctx.session_token = try generateToken();
    persistSession(ctx.session_token.?);
    return ctx.session_token.?;
}

pub fn load(ctx: *core.Context) void {
    if (std.fs.openFileAbsolute(core.config.session_path, .{})) |session_file| {
        defer session_file.close();
        if (session_file.readToEndAlloc(core.allocator, 256)) |token| {
            const trimmed = std.mem.trim(u8, token, " \r\n\t");
            if (trimmed.len >= 32) ctx.session_token = core.allocator.dupe(u8, trimmed) catch null;
            core.allocator.free(token);
        } else |_| {}
    } else |_| {}
    const file = std.fs.openFileAbsolute(core.config.auth_path, .{}) catch return;
    defer file.close();
    const data = file.readToEndAlloc(core.allocator, 64 * 1024) catch return;
    ctx.auth_store = std.json.parseFromSliceLeaky(core.AuthStore, core.allocator, data, .{}) catch return;
}

pub fn save(ctx: *core.Context) !void {
    const body = try std.fmt.allocPrint(core.allocator, "{f}", .{std.json.fmt(ctx.auth_store, .{})});
    defer core.allocator.free(body);
    var file = try std.fs.createFileAbsolute(core.config.auth_path, .{ .truncate = true, .mode = 0o600 });
    defer file.close();
    try file.writeAll(body);
}

fn matchesBearer(token: []const u8, value: []const u8) bool {
    const trimmed = std.mem.trim(u8, value, " \t");
    return std.mem.startsWith(u8, trimmed, "Bearer ") and std.mem.eql(u8, std.mem.trim(u8, trimmed[7..], " \t"), token);
}

/// Browsers cannot set headers on WebSocket requests: the session token is
/// passed as a subprotocol "panel-auth.<token>" next to "panel.v1".
pub const ws_protocol = "panel.v1";
const ws_auth_prefix = "panel-auth.";

pub fn isWebSocketAuthorized(ctx: *const core.Context, req: *std.http.Server.Request) bool {
    const token = ctx.session_token orelse return false;
    var headers = req.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "sec-websocket-protocol")) continue;
        var protocols = std.mem.splitScalar(u8, header.value, ',');
        while (protocols.next()) |protocol| {
            const value = std.mem.trim(u8, protocol, " \t");
            if (std.mem.startsWith(u8, value, ws_auth_prefix) and std.mem.eql(u8, value[ws_auth_prefix.len..], token)) return true;
        }
    }
    return false;
}

pub fn isAuthorized(ctx: *const core.Context, req: *std.http.Server.Request) bool {
    const token = ctx.session_token orelse return false;
    var headers = req.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "authorization")) continue;
        return matchesBearer(token, header.value);
    }
    return false;
}

fn validateClientData(raw: []const u8, expected_type: []const u8, challenge: []const u8) !void {
    const Data = struct { type: []const u8, challenge: []const u8, origin: []const u8, crossOrigin: ?bool = null };
    const data = std.json.parseFromSliceLeaky(Data, core.allocator, raw, .{}) catch return error.InvalidClientData;
    if (!std.mem.eql(u8, data.type, expected_type)) return error.InvalidClientData;
    if (!std.mem.eql(u8, data.challenge, challenge)) return error.InvalidClientData;
    if (!std.mem.eql(u8, data.origin, core.config.origin)) return error.InvalidClientData;
}

pub fn register(ctx: *core.Context, input: core.RegistrationInput) ![]const u8 {
    const challenge = ctx.pending_challenge orelse return error.NoChallenge;
    try validateClientData(input.clientDataJSON, "webauthn.create", challenge);
    const result = try passcay.register.verify(core.allocator, .{ .attestation_object = input.attestationObject, .client_data_json = input.clientDataJSON }, .{ .challenge = challenge, .origin = core.config.origin, .rp_id = core.config.rp_id, .require_user_verification = true });
    ctx.auth_store.owner = try core.allocator.dupe(u8, input.owner);
    ctx.auth_store.credential = .{ .credential_id = result.credential_id, .public_key = result.public_key, .sign_count = result.sign_count };
    ctx.pending_challenge = null;
    try save(ctx);
    return newSession(ctx);
}

pub fn login(ctx: *core.Context, input: core.LoginInput) ![]const u8 {
    const challenge = ctx.pending_challenge orelse return error.NoChallenge;
    const credential = ctx.auth_store.credential orelse return error.NotConfigured;
    if (!std.mem.eql(u8, input.credentialId, credential.credential_id)) return error.UnknownCredential;
    try validateClientData(input.clientDataJSON, "webauthn.get", challenge);
    const result = try passcay.auth.verify(core.allocator, .{ .authenticator_data = input.authenticatorData, .client_data_json = input.clientDataJSON, .signature = input.signature }, .{ .public_key = credential.public_key, .challenge = challenge, .origin = core.config.origin, .rp_id = core.config.rp_id, .require_user_verification = true, .known_sign_count = credential.sign_count });
    ctx.auth_store.credential.?.sign_count = result.recommended_sign_count;
    ctx.pending_challenge = null;
    try save(ctx);
    return newSession(ctx);
}

/// PANEL_AUTH=password. Digests are compared in constant time; after 5
/// failures further attempts are refused for 30 s (caller holds ctx.mutex).
pub fn passwordLogin(ctx: *core.Context, password: []const u8) ![]const u8 {
    const now = std.time.timestamp();
    if (ctx.failed_logins >= 5 and now - ctx.failed_login_s < 30) return error.TooManyAttempts;
    var given: [32]u8 = undefined;
    var expected: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(password, &given, .{});
    std.crypto.hash.sha2.Sha256.hash(core.config.password, &expected, .{});
    if (!std.crypto.timing_safe.eql([32]u8, given, expected)) {
        if (now - ctx.failed_login_s >= 30) ctx.failed_logins = 0;
        ctx.failed_logins += 1;
        ctx.failed_login_s = now;
        return error.WrongPassword;
    }
    ctx.failed_logins = 0;
    return newSession(ctx);
}
