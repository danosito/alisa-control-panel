//! Who may use the panel: credentials (passkeys and passwords, in any mix,
//! typically one per device), sessions, and the pairing invite that lets a
//! signed-in device admit a new one. PANEL_PASSWORD, if set, is one more
//! password (id "env") managed in panel.env.
//!
//! Files in $PANEL_DATA_DIR (0600, written atomically):
//!   auth.json      {"owner", "passkeys": [Passkey], "passwords": [Password]}
//!                  (v1 {"credential"} migrated; passwords are argon2id hashes)
//!   sessions.json  [{"hash", "credential", "label", ...}] SHA-256 of each token only
//!
//! A new device gets a passkey or a password in one of three ways:
//!   - first passkey ever (no invite needed),
//!   - the request already carries a session (another key on the same device),
//!   - an 8-character invite created on a signed-in device (QR/link/code,
//!     10 minutes, single use, 10 wrong guesses burn it).
//! Every caller holds ctx.mutex.
const std = @import("std");
const passcay = @import("passcay");
const core = @import("core.zig");

const A = core.allocator;

pub const Token = [43]u8; // base64url of 32 random bytes
pub const invite_len = 8;
/// No 0/O/1/I: codes are read aloud and typed on TVs.
const invite_alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const session_idle_s: i64 = 90 * 24 * 3600;
const max_sessions = 24;
const max_passkeys = 32;
const challenge_ttl_ms: i64 = 5 * 60 * 1000;
const invite_ttl_s: i64 = 10 * 60;
const invite_max_failures = 10;
/// last_seen reaches flash at most this often per session.
const seen_flush_s: i64 = 3600;

/// The station boots with its clock at 1970 until NTP syncs. Wall-clock
/// session ages only count when both ends are real dates; challenges and
/// invites use the monotonic clock.
fn wallSane(t: i64) bool {
    return t > 1_600_000_000;
}

fn monoMs() i64 {
    const ts = std.posix.clock_gettime(.MONOTONIC) catch return std.time.milliTimestamp();
    return @as(i64, ts.sec) * 1000 + @divTrunc(@as(i64, ts.nsec), 1_000_000);
}

fn idle(now: i64, last_seen: i64) bool {
    return wallSane(now) and wallSane(last_seen) and now - last_seen > session_idle_s;
}

/// id of the PANEL_PASSWORD credential.
pub const env_password_id = "env";
const max_passwords = 16;
/// OWASP's argon2id choice for low memory; ~0.4 s per check on the station.
const password_params: std.crypto.pwhash.argon2.Params = .{ .t = 3, .m = 12 * 1024, .p = 1 };
const min_password_len = 8;

pub const Session = struct {
    hash: [32]u8,
    /// Credential (passkey or password id) this session was opened with.
    credential: []const u8,
    label: []const u8,
    created_s: i64,
    last_seen_s: i64,
    saved_seen_s: i64,
};

pub const Grant = union(enum) { first, session: [32]u8, invite: [invite_len]u8 };
const ChallengeKind = enum { register, login };
const Challenge = struct { value: Token, kind: ChallengeKind, grant: Grant, expires_ms: i64 };

pub const Invite = struct { code: [invite_len]u8, expires_ms: i64, failures: u8 = 0 };

pub const State = struct {
    owner: []const u8 = "",
    passkeys: std.ArrayList(core.Passkey) = .empty,
    passwords: std.ArrayList(core.Password) = .empty,
    sessions: std.ArrayList(Session) = .empty,
    /// One argon2 computation at a time (12 MiB each), outside ctx.mutex.
    hashing: std.Thread.Mutex = .{},
    challenges: [8]?Challenge = @splat(null),
    invite: ?Invite = null,
    /// Bumped on every revocation; long-lived sockets re-check their session.
    epoch: std.atomic.Value(u32) = .init(0),
    failed_logins: u32 = 0,
    failed_login_s: i64 = 0,
};

// ---------------------------------------------------------------- tokens

pub fn newToken() Token {
    var raw: [32]u8 = undefined;
    std.crypto.random.bytes(&raw);
    var out: Token = undefined;
    _ = std.base64.url_safe_no_pad.Encoder.encode(&out, &raw);
    return out;
}

fn hashToken(token: []const u8) [32]u8 {
    var out: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(token, &out, .{});
    return out;
}

/// Public handle of a session (first 8 bytes of the token hash, hex).
pub fn sessionId(session: *const Session) [16]u8 {
    return std.fmt.bytesToHex(session.hash[0..8].*, .lower);
}

// ---------------------------------------------------------------- persistence

const LegacyCredential = struct { credential_id: []const u8, public_key: []const u8, sign_count: u32 = 0 };
const AuthFile = struct { owner: []const u8 = "", passkeys: []const core.Passkey = &.{}, passwords: []const core.Password = &.{}, credential: ?LegacyCredential = null };
/// "passkey": the field name before passwords existed.
const SessionRecord = struct { hash: []const u8, credential: []const u8 = "", passkey: []const u8 = "", label: []const u8 = "", created_s: i64 = 0, last_seen_s: i64 = 0 };
const SessionOut = struct { hash: []const u8, credential: []const u8, label: []const u8, created_s: i64, last_seen_s: i64 };

fn writeJson(path: []const u8, value: anytype) !void {
    const body = try std.fmt.allocPrint(A, "{f}", .{std.json.fmt(value, .{ .emit_null_optional_fields = false })});
    defer A.free(body);
    try core.writeFileAtomic(path, body);
}

fn readFile(path: []const u8) ?[]u8 {
    const file = std.fs.openFileAbsolute(path, .{}) catch return null;
    defer file.close();
    return file.readToEndAlloc(A, 256 * 1024) catch null;
}

pub fn saveAuth(ctx: *core.Context) !void {
    try writeJson(core.config.auth_path, AuthFile{ .owner = ctx.auth.owner, .passkeys = ctx.auth.passkeys.items, .passwords = ctx.auth.passwords.items });
}

pub fn saveSessions(ctx: *core.Context) !void {
    const records = try A.alloc(SessionOut, ctx.auth.sessions.items.len);
    defer A.free(records);
    const hexes = try A.alloc([64]u8, ctx.auth.sessions.items.len);
    defer A.free(hexes);
    for (ctx.auth.sessions.items, records, hexes) |*s, *r, *hex| {
        hex.* = std.fmt.bytesToHex(s.hash, .lower);
        r.* = .{ .hash = hex, .credential = s.credential, .label = s.label, .created_s = s.created_s, .last_seen_s = s.last_seen_s };
        s.saved_seen_s = s.last_seen_s;
    }
    try writeJson(core.config.sessions_path, records);
}

fn dupePasskey(p: core.Passkey) !core.Passkey {
    return .{ .id = try A.dupe(u8, p.id), .public_key = try A.dupe(u8, p.public_key), .sign_count = p.sign_count, .name = try A.dupe(u8, p.name), .aaguid = try A.dupe(u8, p.aaguid), .created_s = p.created_s, .last_used_s = p.last_used_s };
}

fn freePasskey(p: core.Passkey) void {
    A.free(p.id);
    A.free(p.public_key);
    A.free(p.name);
    A.free(p.aaguid);
}

fn dupePassword(p: core.Password) !core.Password {
    return .{ .id = try A.dupe(u8, p.id), .name = try A.dupe(u8, p.name), .hash = try A.dupe(u8, p.hash), .created_s = p.created_s, .last_used_s = p.last_used_s };
}

fn freePassword(p: core.Password) void {
    A.free(p.id);
    A.free(p.name);
    A.free(p.hash);
}

fn freeSession(s: Session) void {
    A.free(s.credential);
    A.free(s.label);
}

pub fn load(ctx: *core.Context) void {
    loadAuth(ctx) catch |err| std.log.err("auth.json unreadable: {t}", .{err});
    loadSessions(ctx) catch |err| std.log.err("sessions.json unreadable: {t}", .{err});
    migrateLegacySession(ctx);
}

fn loadAuth(ctx: *core.Context) !void {
    const data = readFile(core.config.auth_path) orelse return;
    defer A.free(data);
    const parsed = try std.json.parseFromSlice(AuthFile, A, data, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    ctx.auth.owner = try A.dupe(u8, parsed.value.owner);
    for (parsed.value.passkeys) |p| try ctx.auth.passkeys.append(A, try dupePasskey(p));
    for (parsed.value.passwords) |p| try ctx.auth.passwords.append(A, try dupePassword(p));
    if (ctx.auth.passkeys.items.len == 0) if (parsed.value.credential) |legacy| {
        // v1 kept a single passkey; it becomes the first entry of the list.
        try ctx.auth.passkeys.append(A, try dupePasskey(.{ .id = legacy.credential_id, .public_key = legacy.public_key, .sign_count = legacy.sign_count, .name = "Первый ключ" }));
        try saveAuth(ctx);
        std.log.info("auth.json migrated to the multi-passkey format", .{});
    };
}

fn loadSessions(ctx: *core.Context) !void {
    const data = readFile(core.config.sessions_path) orelse return;
    defer A.free(data);
    const parsed = try std.json.parseFromSlice([]const SessionRecord, A, data, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const now = std.time.timestamp();
    for (parsed.value) |r| {
        var hash: [32]u8 = undefined;
        if (r.hash.len != 64) continue;
        _ = std.fmt.hexToBytes(&hash, r.hash) catch continue;
        if (idle(now, r.last_seen_s)) continue;
        try ctx.auth.sessions.append(A, .{ .hash = hash, .credential = try A.dupe(u8, if (r.credential.len > 0) r.credential else r.passkey), .label = try A.dupe(u8, r.label), .created_s = r.created_s, .last_seen_s = r.last_seen_s, .saved_seen_s = r.last_seen_s });
    }
}

/// Pre-0.5 builds kept one plaintext token in "session": keep that browser
/// signed in, bound to the first passkey.
fn migrateLegacySession(ctx: *core.Context) void {
    const data = readFile(core.config.session_path) orelse return;
    defer A.free(data);
    const token = std.mem.trim(u8, data, " \r\n\t");
    if (token.len >= 32) {
        const owner_key = if (ctx.auth.passkeys.items.len > 0) ctx.auth.passkeys.items[0].id else "";
        addSession(ctx, hashToken(token), owner_key, "Этот браузер") catch return;
    }
    std.fs.deleteFileAbsolute(core.config.session_path) catch {};
    std.log.info("legacy session migrated to sessions.json", .{});
}

// ---------------------------------------------------------------- sessions

fn addSession(ctx: *core.Context, hash: [32]u8, credential: []const u8, label: []const u8) !void {
    const now = std.time.timestamp();
    // Drop idle sessions, then the least recently seen one if still full.
    var i: usize = 0;
    while (i < ctx.auth.sessions.items.len) {
        if (idle(now, ctx.auth.sessions.items[i].last_seen_s)) freeSession(ctx.auth.sessions.swapRemove(i)) else i += 1;
    }
    if (ctx.auth.sessions.items.len >= max_sessions) {
        var oldest: usize = 0;
        for (ctx.auth.sessions.items, 0..) |s, j| {
            if (s.last_seen_s < ctx.auth.sessions.items[oldest].last_seen_s) oldest = j;
        }
        freeSession(ctx.auth.sessions.swapRemove(oldest));
    }
    var buf: [96]u8 = undefined;
    try ctx.auth.sessions.append(A, .{ .hash = hash, .credential = try A.dupe(u8, credential), .label = try A.dupe(u8, cleanLabel(&buf, label, "Браузер")), .created_s = now, .last_seen_s = now, .saved_seen_s = now });
    try saveSessions(ctx);
}

fn createSession(ctx: *core.Context, credential: []const u8, label: []const u8) !Token {
    const token = newToken();
    try addSession(ctx, hashToken(&token), credential, label);
    return token;
}

fn findSessionByToken(ctx: *core.Context, token: []const u8) ?*Session {
    const hash = hashToken(token);
    const now = std.time.timestamp();
    for (ctx.auth.sessions.items) |*s| {
        if (!std.crypto.timing_safe.eql([32]u8, s.hash, hash)) continue;
        if (idle(now, s.last_seen_s)) return null;
        if (wallSane(now) and now > s.last_seen_s) {
            // Sessions created before NTP carry a 1970 date: this fixes it.
            const stale = !wallSane(s.saved_seen_s) or now - s.saved_seen_s > seen_flush_s;
            s.last_seen_s = now;
            if (stale) saveSessions(ctx) catch {};
        }
        return s;
    }
    return null;
}

fn bearerToken(req: *std.http.Server.Request) ?[]const u8 {
    var headers = req.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "authorization")) continue;
        const value = std.mem.trim(u8, header.value, " \t");
        if (!std.mem.startsWith(u8, value, "Bearer ")) return null;
        return std.mem.trim(u8, value[7..], " \t");
    }
    return null;
}

/// Browsers cannot set headers on WebSocket requests: the session token is
/// passed as a subprotocol "panel-auth.<token>" next to "panel.v1".
pub const ws_protocol = "panel.v1";
const ws_auth_prefix = "panel-auth.";

fn webSocketToken(req: *std.http.Server.Request) ?[]const u8 {
    var headers = req.iterateHeaders();
    while (headers.next()) |header| {
        if (!std.ascii.eqlIgnoreCase(header.name, "sec-websocket-protocol")) continue;
        var protocols = std.mem.splitScalar(u8, header.value, ',');
        while (protocols.next()) |protocol| {
            const value = std.mem.trim(u8, protocol, " \t");
            if (std.mem.startsWith(u8, value, ws_auth_prefix)) return value[ws_auth_prefix.len..];
        }
    }
    return null;
}

/// The session of an HTTP request (Authorization: Bearer <token>).
/// Call it before reading the request body.
pub fn currentSession(ctx: *core.Context, req: *std.http.Server.Request) ?*Session {
    return findSessionByToken(ctx, bearerToken(req) orelse return null);
}

pub fn isAuthorized(ctx: *core.Context, req: *std.http.Server.Request) bool {
    return currentSession(ctx, req) != null;
}

/// Hash of the WebSocket's session, kept by the socket to notice revocation.
pub fn webSocketSession(ctx: *core.Context, req: *std.http.Server.Request) ?[32]u8 {
    const session = findSessionByToken(ctx, webSocketToken(req) orelse return null) orelse return null;
    return session.hash;
}

pub fn sessionAlive(ctx: *core.Context, hash: [32]u8) bool {
    for (ctx.auth.sessions.items) |s| if (std.crypto.timing_safe.eql([32]u8, s.hash, hash)) return true;
    return false;
}

/// Seconds until the invite expires (clients show a countdown).
pub fn inviteRemaining(invite: Invite) i64 {
    return @max(0, @divTrunc(invite.expires_ms - monoMs(), 1000));
}

/// For long-lived sockets (no lock held): has a revocation happened since
/// `seen`, and if so, is this session still valid?
pub fn stillSignedIn(ctx: *core.Context, hash: [32]u8, seen: *u32) bool {
    const epoch = ctx.auth.epoch.load(.acquire);
    if (epoch == seen.*) return true;
    seen.* = epoch;
    ctx.mutex.lock();
    defer ctx.mutex.unlock();
    return sessionAlive(ctx, hash);
}

fn removeSessions(ctx: *core.Context, comptime match: anytype, arg: anytype) !usize {
    var i: usize = 0;
    var removed: usize = 0;
    while (i < ctx.auth.sessions.items.len) {
        if (match(&ctx.auth.sessions.items[i], arg)) {
            freeSession(ctx.auth.sessions.swapRemove(i));
            removed += 1;
        } else i += 1;
    }
    if (removed > 0) {
        _ = ctx.auth.epoch.fetchAdd(1, .release);
        try saveSessions(ctx);
    }
    return removed;
}

pub fn logout(ctx: *core.Context, current: *Session) !void {
    const hash = current.hash;
    _ = try removeSessions(ctx, struct {
        fn match(s: *const Session, target: [32]u8) bool {
            return std.mem.eql(u8, &s.hash, &target);
        }
    }.match, hash);
}

/// Revokes the session with this public id, or every other one when id is null.
pub fn revokeSessions(ctx: *core.Context, current: *Session, id: ?[]const u8) !usize {
    const Target = struct { keep: [32]u8, id: ?[]const u8 };
    return removeSessions(ctx, struct {
        fn match(s: *const Session, t: Target) bool {
            if (t.id) |wanted| return std.mem.eql(u8, &sessionId(s), wanted);
            return !std.mem.eql(u8, &s.hash, &t.keep);
        }
    }.match, Target{ .keep = current.hash, .id = id });
}

// ---------------------------------------------------------------- challenges

fn newChallenge(ctx: *core.Context, kind: ChallengeKind, grant: Grant) Token {
    const now = monoMs();
    var slot: usize = 0;
    var oldest: i64 = std.math.maxInt(i64);
    for (ctx.auth.challenges, 0..) |c, i| {
        const expires = if (c) |v| v.expires_ms else std.math.minInt(i64);
        if (expires < now) {
            slot = i;
            break;
        }
        if (expires < oldest) {
            oldest = expires;
            slot = i;
        }
    }
    const value = newToken();
    ctx.auth.challenges[slot] = .{ .value = value, .kind = kind, .grant = grant, .expires_ms = now + challenge_ttl_ms };
    return value;
}

fn takeChallenge(ctx: *core.Context, kind: ChallengeKind, value: []const u8) ?Challenge {
    const now = monoMs();
    for (&ctx.auth.challenges) |*slot| {
        const c = slot.* orelse continue;
        if (c.kind != kind or !std.mem.eql(u8, &c.value, value)) continue;
        slot.* = null;
        return if (c.expires_ms >= now) c else null;
    }
    return null;
}

/// Checks type and origin of clientDataJSON and returns its challenge.
fn clientChallenge(arena: std.mem.Allocator, raw: []const u8, expected_type: []const u8) ![]const u8 {
    const Data = struct { type: []const u8, challenge: []const u8, origin: []const u8 };
    const data = std.json.parseFromSliceLeaky(Data, arena, raw, .{ .ignore_unknown_fields = true }) catch return error.InvalidClientData;
    if (!std.mem.eql(u8, data.type, expected_type)) return error.InvalidClientData;
    if (!std.mem.eql(u8, data.origin, core.config.origin)) return error.InvalidClientData;
    return data.challenge;
}

// ---------------------------------------------------------------- invites

pub fn createInvite(ctx: *core.Context) Invite {
    var code: [invite_len]u8 = undefined;
    for (&code) |*c| c.* = invite_alphabet[std.crypto.random.uintLessThan(u8, invite_alphabet.len)];
    ctx.auth.invite = .{ .code = code, .expires_ms = monoMs() + invite_ttl_s * 1000 };
    return ctx.auth.invite.?;
}

pub fn cancelInvite(ctx: *core.Context) void {
    ctx.auth.invite = null;
}

pub fn activeInvite(ctx: *core.Context) ?Invite {
    const invite = ctx.auth.invite orelse return null;
    if (invite.expires_ms < monoMs()) {
        ctx.auth.invite = null;
        return null;
    }
    return invite;
}

/// "k7q2-mx4d" -> "K7Q2MX4D"; null if it cannot be a code at all.
fn normalizeCode(input: []const u8) ?[invite_len]u8 {
    var out: [invite_len]u8 = undefined;
    var n: usize = 0;
    for (input) |raw| {
        if (raw == '-' or raw == ' ') continue;
        const c = std.ascii.toUpper(raw);
        if (std.mem.indexOfScalar(u8, invite_alphabet, c) == null or n == invite_len) return null;
        out[n] = c;
        n += 1;
    }
    return if (n == invite_len) out else null;
}

/// Validates a typed or scanned code. Wrong guesses count against the invite.
pub fn checkInvite(ctx: *core.Context, input: []const u8) ?[invite_len]u8 {
    const invite = activeInvite(ctx) orelse return null;
    if (normalizeCode(input)) |code| {
        if (std.crypto.timing_safe.eql([invite_len]u8, code, invite.code)) return code;
    }
    ctx.auth.invite.?.failures += 1;
    if (ctx.auth.invite.?.failures >= invite_max_failures) ctx.auth.invite = null;
    return null;
}

fn grantValid(ctx: *core.Context, grant: Grant) bool {
    return switch (grant) {
        .first => !configured(ctx),
        .session => |hash| sessionAlive(ctx, hash),
        .invite => |code| if (activeInvite(ctx)) |invite| std.crypto.timing_safe.eql([invite_len]u8, code, invite.code) else false,
    };
}

// ---------------------------------------------------------------- passkeys

pub fn findPasskey(ctx: *core.Context, id: []const u8) ?*core.Passkey {
    for (ctx.auth.passkeys.items) |*p| if (std.mem.eql(u8, p.id, id)) return p;
    return null;
}

/// Any credential at all (including PANEL_PASSWORD)?
pub fn configured(ctx: *core.Context) bool {
    return ctx.auth.passkeys.items.len + ctx.auth.passwords.items.len > 0 or core.config.password.len > 0;
}

fn credentialCount(ctx: *core.Context) usize {
    return ctx.auth.passkeys.items.len + ctx.auth.passwords.items.len + @intFromBool(core.config.password.len > 0);
}

/// Which grant lets this device add a credential. `current`: the request's
/// session, looked up BEFORE its body was read (std.http forbids touching the
/// headers afterwards).
fn admit(ctx: *core.Context, current: ?*Session, owner: []const u8, invite: []const u8) !Grant {
    const grant: Grant = if (!configured(ctx))
        .first
    else if (current) |session|
        .{ .session = session.hash }
    else if (invite.len == 0)
        return error.InviteRequired
    else if (checkInvite(ctx, invite)) |code|
        .{ .invite = code }
    else
        return error.InvalidInvite;
    if (grant == .first and std.mem.trim(u8, owner, " \t\r\n").len == 0) return error.OwnerRequired;
    return grant;
}

fn setOwner(ctx: *core.Context, owner: []const u8) !void {
    var buf: [96]u8 = undefined;
    const owned = try A.dupe(u8, cleanLabel(&buf, owner, "Владелец"));
    A.free(ctx.auth.owner);
    ctx.auth.owner = owned;
}

pub const Begin = struct { challenge: Token, owner: []const u8 };

/// Passkey registration options.
pub fn beginRegistration(ctx: *core.Context, current: ?*Session, input: core.RegistrationStart) !Begin {
    if (ctx.auth.passkeys.items.len >= max_passkeys) return error.TooManyPasskeys;
    const grant = try admit(ctx, current, input.owner, input.invite);
    return .{ .challenge = newChallenge(ctx, .register, grant), .owner = if (grant == .first) input.owner else ctx.auth.owner };
}

pub fn register(ctx: *core.Context, arena: std.mem.Allocator, input: core.RegistrationInput) !Token {
    const challenge = try clientChallenge(arena, input.clientDataJSON, "webauthn.create");
    const pending = takeChallenge(ctx, .register, challenge) orelse return error.NoChallenge;
    // The invite or session that admitted this device may be gone by now.
    if (!grantValid(ctx, pending.grant)) return error.GrantExpired;
    const result = try passcay.register.verify(arena, .{ .attestation_object = input.attestationObject, .client_data_json = input.clientDataJSON }, .{ .challenge = challenge, .origin = core.config.origin, .rp_id = core.config.rp_id, .require_user_verification = true });
    if (findPasskey(ctx, result.credential_id) != null) return error.AlreadyRegistered;
    if (pending.grant == .first) try setOwner(ctx, input.owner);
    var buf: [96]u8 = undefined;
    const name = cleanLabel(&buf, input.name, providerName(result.aaguid) orelse "Passkey");
    const now = std.time.timestamp();
    try ctx.auth.passkeys.append(A, try dupePasskey(.{ .id = result.credential_id, .public_key = result.public_key, .sign_count = result.sign_count, .name = name, .aaguid = result.aaguid, .created_s = now, .last_used_s = now }));
    if (pending.grant == .invite) ctx.auth.invite = null; // single use
    try saveAuth(ctx);
    return createSession(ctx, result.credential_id, name);
}

pub fn beginLogin(ctx: *core.Context) !Token {
    if (ctx.auth.passkeys.items.len == 0) return error.NotConfigured;
    return newChallenge(ctx, .login, .first);
}

pub fn login(ctx: *core.Context, arena: std.mem.Allocator, input: core.LoginInput) !Token {
    const challenge = try clientChallenge(arena, input.clientDataJSON, "webauthn.get");
    _ = takeChallenge(ctx, .login, challenge) orelse return error.NoChallenge;
    const passkey = findPasskey(ctx, input.credentialId) orelse return error.UnknownCredential;
    const result = try passcay.auth.verify(arena, .{ .authenticator_data = input.authenticatorData, .client_data_json = input.clientDataJSON, .signature = input.signature }, .{ .public_key = passkey.public_key, .challenge = challenge, .origin = core.config.origin, .rp_id = core.config.rp_id, .require_user_verification = true, .known_sign_count = passkey.sign_count });
    passkey.sign_count = result.recommended_sign_count;
    passkey.last_used_s = std.time.timestamp();
    try saveAuth(ctx);
    return createSession(ctx, passkey.id, if (input.device.len > 0) input.device else passkey.name);
}

// ---------------------------------------------------------------- passwords

fn findPassword(ctx: *core.Context, id: []const u8) ?*core.Password {
    for (ctx.auth.passwords.items) |*p| if (std.mem.eql(u8, p.id, id)) return p;
    return null;
}

/// Runs with ctx.mutex released (argon2 takes ~0.4 s), one hash at a time.
fn hashPassword(ctx: *core.Context, password: []const u8, out: *[128]u8) ![]const u8 {
    ctx.mutex.unlock();
    defer ctx.mutex.lock();
    ctx.auth.hashing.lock();
    defer ctx.auth.hashing.unlock();
    return std.crypto.pwhash.argon2.strHash(password, .{ .allocator = A, .params = password_params, .mode = .argon2id }, out);
}

/// A new password credential. Returns a session for a device that was not
/// signed in yet (first credential, invite), null for a signed-in device.
pub fn createPassword(ctx: *core.Context, current: ?*Session, input: core.PasswordCreateInput) !?Token {
    if ((std.unicode.utf8CountCodepoints(input.password) catch 0) < min_password_len) return error.PasswordTooShort;
    if (input.password.len > 256) return error.PasswordTooLong;
    if (ctx.auth.passwords.items.len >= max_passwords) return error.TooManyPasswords;
    const grant = try admit(ctx, current, input.owner, input.invite);
    var hash_buf: [128]u8 = undefined;
    const hash = try hashPassword(ctx, input.password, &hash_buf);
    // Re-check after the unlocked hashing: the invite may have been used meanwhile.
    if (!grantValid(ctx, grant)) return error.GrantExpired;
    if (grant == .first) try setOwner(ctx, input.owner);
    var id_raw: [6]u8 = undefined;
    std.crypto.random.bytes(&id_raw);
    var id_buf: [15]u8 = undefined;
    const id = std.fmt.bufPrint(&id_buf, "pw-{s}", .{&std.fmt.bytesToHex(id_raw, .lower)}) catch unreachable;
    var buf: [96]u8 = undefined;
    const name = cleanLabel(&buf, input.name, "Пароль");
    const now = std.time.timestamp();
    // Added from a signed-in device: not used to sign in yet.
    try ctx.auth.passwords.append(A, try dupePassword(.{ .id = id, .name = name, .hash = hash, .created_s = now, .last_used_s = if (grant == .session) 0 else now }));
    if (grant == .invite) ctx.auth.invite = null; // single use
    try saveAuth(ctx);
    if (grant == .session) return null;
    return try createSession(ctx, id, if (input.device.len > 0) input.device else name);
}

/// Accepts PANEL_PASSWORD or any stored password. Stored ones are checked
/// most recently used first, with ctx.mutex released; after 5 failures further
/// attempts are refused for 30 s.
pub fn passwordLogin(ctx: *core.Context, arena: std.mem.Allocator, password: []const u8, device: []const u8) !Token {
    const now = std.time.timestamp();
    if (ctx.auth.failed_logins >= 5 and now - ctx.auth.failed_login_s < 30) return error.TooManyAttempts;
    if (core.config.password.len > 0) {
        var given: [32]u8 = undefined;
        var expected: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(password, &given, .{});
        std.crypto.hash.sha2.Sha256.hash(core.config.password, &expected, .{});
        if (std.crypto.timing_safe.eql([32]u8, given, expected)) {
            ctx.auth.failed_logins = 0;
            return createSession(ctx, env_password_id, device);
        }
    }
    const Candidate = struct { id: []const u8, hash: []const u8, used: i64 };
    const candidates = try arena.alloc(Candidate, ctx.auth.passwords.items.len);
    for (ctx.auth.passwords.items, candidates) |p, *c| c.* = .{ .id = try arena.dupe(u8, p.id), .hash = try arena.dupe(u8, p.hash), .used = p.last_used_s };
    std.mem.sort(Candidate, candidates, {}, struct {
        fn newer(_: void, a: Candidate, b: Candidate) bool {
            return a.used > b.used;
        }
    }.newer);
    const match: ?[]const u8 = blk: {
        ctx.mutex.unlock();
        defer ctx.mutex.lock();
        ctx.auth.hashing.lock();
        defer ctx.auth.hashing.unlock();
        for (candidates) |c| {
            std.crypto.pwhash.argon2.strVerify(c.hash, password, .{ .allocator = A }) catch continue;
            break :blk c.id;
        }
        break :blk null;
    };
    // Removed while we were checking? Then it no longer counts.
    const found = if (match) |id| findPassword(ctx, id) else null;
    const credential = found orelse {
        if (now - ctx.auth.failed_login_s >= 30) ctx.auth.failed_logins = 0;
        ctx.auth.failed_logins += 1;
        ctx.auth.failed_login_s = now;
        return error.WrongPassword;
    };
    ctx.auth.failed_logins = 0;
    credential.last_used_s = std.time.timestamp();
    try saveAuth(ctx);
    return createSession(ctx, credential.id, if (device.len > 0) device else credential.name);
}

// ---------------------------------------------------------------- any credential

pub fn renameCredential(ctx: *core.Context, id: []const u8, name: []const u8) !void {
    var buf: [96]u8 = undefined;
    const clean = cleanLabel(&buf, name, "");
    if (clean.len == 0) return error.EmptyName;
    const slot: *[]const u8 = if (findPasskey(ctx, id)) |p| &p.name else if (findPassword(ctx, id)) |p| &p.name else return error.UnknownCredential;
    const owned = try A.dupe(u8, clean);
    A.free(slot.*);
    slot.* = owned;
    try saveAuth(ctx);
}

/// Deletes a passkey or password and signs out every session opened with it.
/// The last way in stays: without it nobody could sign in again.
pub fn removeCredential(ctx: *core.Context, id: []const u8) !void {
    if (std.mem.eql(u8, id, env_password_id)) return error.ManagedInEnv;
    const Found = union(enum) { passkey: usize, password: usize };
    const found: Found = for (ctx.auth.passkeys.items, 0..) |p, i| {
        if (std.mem.eql(u8, p.id, id)) break .{ .passkey = i };
    } else for (ctx.auth.passwords.items, 0..) |p, i| {
        if (std.mem.eql(u8, p.id, id)) break .{ .password = i };
    } else return error.UnknownCredential;
    if (credentialCount(ctx) <= 1) return error.LastCredential;
    // Sessions first: `id` may point into the record that is freed below.
    _ = try removeSessions(ctx, struct {
        fn match(s: *const Session, key: []const u8) bool {
            return std.mem.eql(u8, s.credential, key);
        }
    }.match, id);
    switch (found) {
        .passkey => |i| freePasskey(ctx.auth.passkeys.orderedRemove(i)),
        .password => |i| freePassword(ctx.auth.passwords.orderedRemove(i)),
    }
    try saveAuth(ctx);
}

// ---------------------------------------------------------------- labels

/// Trimmed, without control characters, at most 64 bytes of valid UTF-8.
fn cleanLabel(buf: *[96]u8, input: []const u8, fallback: []const u8) []const u8 {
    var n: usize = 0;
    for (std.mem.trim(u8, input, " \t\r\n")) |c| {
        if (c < 0x20 or c == 0x7f) continue;
        if (n == 64) break;
        buf[n] = c;
        n += 1;
    }
    while (n > 0 and !std.unicode.utf8ValidateSlice(buf[0..n])) n -= 1;
    return if (n == 0) fallback else buf[0..n];
}

/// Password managers and platforms by AAGUID (public registry of
/// passkey providers). Unknown or zero AAGUIDs give null.
const providers = [_]struct { uuid: []const u8, name: []const u8 }{
    .{ .uuid = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd", .name = "iCloud Keychain" },
    .{ .uuid = "dd4ec289-e01d-41c9-bb89-70fa845d4bf2", .name = "iCloud Keychain" },
    .{ .uuid = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", .name = "Google Password Manager" },
    .{ .uuid = "adce0002-35bc-c60a-648b-0b25f1f05503", .name = "Chrome на Mac" },
    .{ .uuid = "771b48fd-d3d4-4f74-9232-fc157ab0507a", .name = "Edge на Mac" },
    .{ .uuid = "08987058-cadc-4b81-b6e1-30de50dcbe96", .name = "Windows Hello" },
    .{ .uuid = "9ddd1817-af5a-4672-a2b9-3e3dd95000a9", .name = "Windows Hello" },
    .{ .uuid = "6028b017-b1d4-4c02-b4b3-afcdafc96bb2", .name = "Windows Hello" },
    .{ .uuid = "bada5566-a7aa-401f-bd96-45619a55120d", .name = "1Password" },
    .{ .uuid = "d548826e-79b4-db40-a3d8-11116f7e8349", .name = "Bitwarden" },
    .{ .uuid = "531126d6-e717-415c-9320-3d9aa6981239", .name = "Dashlane" },
    .{ .uuid = "53414d53-554e-4700-0000-000000000000", .name = "Samsung Pass" },
    .{ .uuid = "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6", .name = "Keeper" },
    .{ .uuid = "f3809540-7f14-49c1-a8b3-8f813b225541", .name = "Enpass" },
    .{ .uuid = "fdb141b2-5d84-443e-8a35-4698c205a502", .name = "KeePassXC" },
    .{ .uuid = "50726f74-6f6e-5061-7373-50726f746f6e", .name = "Proton Pass" },
    .{ .uuid = "cb69481e-8ff7-4039-93ec-0a2729a154a8", .name = "YubiKey 5" },
    .{ .uuid = "ee882879-721c-4913-9775-3dfcce97072a", .name = "YubiKey 5" },
    .{ .uuid = "fa2b99dc-9e39-4257-8f92-4a30d23c4118", .name = "YubiKey 5" },
    .{ .uuid = "2fc0579f-8113-47ea-b116-bb5a8db9202a", .name = "YubiKey 5" },
    .{ .uuid = "73bb0cd4-e502-49b8-9c6f-b59445bf720b", .name = "YubiKey 5" },
};

pub fn providerName(aaguid_b64: []const u8) ?[]const u8 {
    var raw: [16]u8 = undefined;
    const size = std.base64.url_safe_no_pad.Decoder.calcSizeForSlice(aaguid_b64) catch return null;
    if (size != 16) return null;
    std.base64.url_safe_no_pad.Decoder.decode(&raw, aaguid_b64) catch return null;
    const hex = std.fmt.bytesToHex(raw, .lower);
    var uuid: [36]u8 = undefined;
    _ = std.fmt.bufPrint(&uuid, "{s}-{s}-{s}-{s}-{s}", .{ hex[0..8], hex[8..12], hex[12..16], hex[16..20], hex[20..32] }) catch return null;
    for (providers) |p| if (std.mem.eql(u8, p.uuid, &uuid)) return p.name;
    return null;
}

// ---------------------------------------------------------------- tests

test "invite codes are normalised and checked" {
    try std.testing.expectEqualStrings("K7Q2MX4D", &(normalizeCode("k7q2-mx4d").?));
    try std.testing.expect(normalizeCode("K7Q2MX4") == null); // too short
    try std.testing.expect(normalizeCode("K7Q2MX4D9") == null); // too long
    try std.testing.expect(normalizeCode("O7Q2MX4D") == null); // ambiguous letter
}

test "labels are trimmed, cleaned and cut on a UTF-8 boundary" {
    var buf: [96]u8 = undefined;
    try std.testing.expectEqualStrings("iPhone · Safari", cleanLabel(&buf, "  iPhone · Safari\n", "x"));
    try std.testing.expectEqualStrings("fallback", cleanLabel(&buf, " \t ", "fallback"));
    const long = "я" ** 40; // 80 bytes
    const cut = cleanLabel(&buf, long, "x");
    try std.testing.expect(cut.len <= 64 and std.unicode.utf8ValidateSlice(cut));
}

test "provider names come from the AAGUID" {
    // fbfc3007-154e-4ecc-8c0b-6e020557d7bd
    try std.testing.expectEqualStrings("iCloud Keychain", providerName("-_wwBxVOTsyMC24CBVfXvQ").?);
    try std.testing.expect(providerName("AAAAAAAAAAAAAAAAAAAAAA") == null);
    try std.testing.expect(providerName("bad") == null);
}

fn testConfig(dir: []const u8) !void {
    const join = struct {
        fn f(d: []const u8, name: []const u8) ![]const u8 {
            return std.fs.path.join(A, &.{ d, name });
        }
    }.f;
    core.config = .{ .name = "test", .data_dir = dir, .web_root = dir, .bind = "127.0.0.1", .port = 0, .tls = true, .tls_cert = "", .tls_key = "", .passkeys = true, .password = "", .origin = "https://panel.test", .rp_id = "panel.test", .auth_path = try join(dir, "auth.json"), .session_path = try join(dir, "session"), .sessions_path = try join(dir, "sessions.json"), .layout_path = try join(dir, "layout.json"), .lights_path = try join(dir, "lights.json") };
}

test "v1 auth.json and the legacy session file are migrated and survive a reload" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(A, ".");
    try testConfig(dir);
    try tmp.dir.writeFile(.{ .sub_path = "auth.json", .data = "{\"owner\":\"dan\",\"credential\":{\"credential_id\":\"CfSz\",\"public_key\":\"pQEC\",\"sign_count\":3}}" });
    const legacy_token = "arDtcimwltD3Z6Y3Wh3hR32PckeX7uQElWr8IxzYbgM";
    try tmp.dir.writeFile(.{ .sub_path = "session", .data = legacy_token ++ "\n" });

    var ctx = core.Context{};
    load(&ctx);
    try std.testing.expectEqualStrings("dan", ctx.auth.owner);
    try std.testing.expectEqual(@as(usize, 1), ctx.auth.passkeys.items.len);
    try std.testing.expectEqualStrings("CfSz", ctx.auth.passkeys.items[0].id);
    try std.testing.expectEqual(@as(u32, 3), ctx.auth.passkeys.items[0].sign_count);
    const session = findSessionByToken(&ctx, legacy_token) orelse return error.TestLegacySessionLost;
    try std.testing.expectEqualStrings("CfSz", session.credential);
    try std.testing.expectError(error.FileNotFound, tmp.dir.access("session", .{}));
    // Only the hash of the token is on disk.
    const sessions_json = try tmp.dir.readFileAlloc(A, "sessions.json", 64 * 1024);
    try std.testing.expect(std.mem.indexOf(u8, sessions_json, legacy_token) == null);

    var again = core.Context{};
    load(&again);
    try std.testing.expectEqual(@as(usize, 1), again.auth.passkeys.items.len);
    try std.testing.expect(findSessionByToken(&again, legacy_token) != null);
    try std.testing.expect(findSessionByToken(&again, "wrong-token-wrong-token-wrong-token-wrong-t") == null);
}

test "invites are single-purpose and burn after repeated wrong guesses" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try testConfig(try tmp.dir.realpathAlloc(A, "."));
    var ctx = core.Context{};
    const invite = createInvite(&ctx);
    try std.testing.expect(inviteRemaining(invite) > 590);
    var typed: [9]u8 = undefined;
    _ = try std.fmt.bufPrint(&typed, "{s}-{s}", .{ invite.code[0..4], invite.code[4..] });
    for (&typed) |*c| c.* = std.ascii.toLower(c.*);
    try std.testing.expect(checkInvite(&ctx, &typed) != null); // case and dash do not matter
    var wrong = invite.code;
    wrong[0] = if (wrong[0] == '2') '3' else '2';
    for (0..invite_max_failures - 1) |_| try std.testing.expect(checkInvite(&ctx, &wrong) == null);
    try std.testing.expect(checkInvite(&ctx, &invite.code) != null); // still alive after 9 misses
    try std.testing.expect(checkInvite(&ctx, &wrong) == null);
    try std.testing.expect(activeInvite(&ctx) == null); // the 10th miss burns it
    try std.testing.expect(checkInvite(&ctx, &invite.code) == null);
}

test "sessions: revoke others, the last passkey stays, removing a key signs its devices out" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try testConfig(try tmp.dir.realpathAlloc(A, "."));
    var ctx = core.Context{};
    try ctx.auth.passkeys.append(A, try dupePasskey(.{ .id = "mac", .public_key = "k1", .name = "MacBook" }));
    const mac = try createSession(&ctx, "mac", "MacBook · Chrome");
    try std.testing.expectError(error.LastCredential, removeCredential(&ctx, "mac"));

    try ctx.auth.passkeys.append(A, try dupePasskey(.{ .id = "phone", .public_key = "k2", .name = "iPhone" }));
    const phone = try createSession(&ctx, "phone", "iPhone · Safari");
    _ = try createSession(&ctx, "phone", "iPad · Safari");
    try std.testing.expectEqual(@as(usize, 3), ctx.auth.sessions.items.len);

    const epoch = ctx.auth.epoch.load(.acquire);
    try removeCredential(&ctx, "phone");
    try std.testing.expect(ctx.auth.epoch.load(.acquire) != epoch);
    try std.testing.expect(findSessionByToken(&ctx, &phone) == null);
    const current = findSessionByToken(&ctx, &mac) orelse return error.TestMacSignedOut;
    _ = try createSession(&ctx, "mac", "Firefox");
    try std.testing.expectEqual(@as(usize, 1), try revokeSessions(&ctx, current, null));
    try std.testing.expectEqual(@as(usize, 1), ctx.auth.sessions.items.len);
}

test "passwords: first setup, sign-in with any of several, wrong ones throttle, env password" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try testConfig(try tmp.dir.realpathAlloc(A, "."));
    var arena = std.heap.ArenaAllocator.init(A);
    defer arena.deinit();
    var ctx = core.Context{};
    ctx.mutex.lock(); // as in the server: handlers run with the lock held
    defer ctx.mutex.unlock();

    try std.testing.expectError(error.OwnerRequired, createPassword(&ctx, null, .{ .password = "long enough" }));
    try std.testing.expectError(error.PasswordTooShort, createPassword(&ctx, null, .{ .owner = "dan", .password = "short" }));
    const first = (try createPassword(&ctx, null, .{ .owner = "dan", .name = "Ноутбук", .password = "первый пароль" })).?;
    try std.testing.expectEqualStrings("dan", ctx.auth.owner);
    try std.testing.expect(std.mem.startsWith(u8, ctx.auth.passwords.items[0].hash, "$argon2id$"));
    // Now configured: a second device needs an invite or a session.
    try std.testing.expectError(error.InviteRequired, createPassword(&ctx, null, .{ .password = "второй пароль" }));
    const invite = createInvite(&ctx);
    _ = (try createPassword(&ctx, null, .{ .invite = &invite.code, .name = "Телефон", .password = "второй пароль" })).?;
    try std.testing.expect(activeInvite(&ctx) == null); // used up
    const mine = findSessionByToken(&ctx, &first).?;
    try std.testing.expect((try createPassword(&ctx, mine, .{ .name = "Запасной", .password = "третий пароль" })) == null);
    try std.testing.expectEqual(@as(usize, 3), ctx.auth.passwords.items.len);

    _ = try passwordLogin(&ctx, arena.allocator(), "второй пароль", "Телефон · Chrome");
    try std.testing.expectError(error.WrongPassword, passwordLogin(&ctx, arena.allocator(), "не тот", ""));

    // Remove two of three; the last one stays.
    try removeCredential(&ctx, ctx.auth.passwords.items[0].id);
    try removeCredential(&ctx, ctx.auth.passwords.items[0].id);
    try std.testing.expectError(error.LastCredential, removeCredential(&ctx, ctx.auth.passwords.items[0].id));
    try std.testing.expect(findSessionByToken(&ctx, &first) == null); // its credential is gone

    // PANEL_PASSWORD is one more way in and lets the stored one go.
    core.config.password = "station password";
    _ = try passwordLogin(&ctx, arena.allocator(), "station password", "");
    try removeCredential(&ctx, ctx.auth.passwords.items[0].id);
    try std.testing.expectError(error.ManagedInEnv, removeCredential(&ctx, env_password_id));
    try std.testing.expectError(error.UnknownCredential, removeCredential(&ctx, "anything"));
    core.config.password = "";
}
