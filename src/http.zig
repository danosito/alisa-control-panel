const std = @import("std");
const passcay = @import("passcay");
const core = @import("core.zig");
const auth = @import("auth.zig");
const bluez = @import("bluez.zig");
const audio = @import("audio.zig");
const metrics = @import("metrics.zig");
const terminal = @import("terminal.zig");
const layout = @import("layout.zig");

const index_html = @embedFile("index.html");

fn json(req: *std.http.Server.Request, value: anytype, status: std.http.Status) !void {
    const body = try std.fmt.allocPrint(core.allocator, "{f}", .{std.json.fmt(value, .{})});
    defer core.allocator.free(body);
    req.respond(body, .{ .status = status, .extra_headers = &.{ .{ .name = "Content-Type", .value = "application/json; charset=utf-8" }, .{ .name = "Cache-Control", .value = "no-store" }, .{ .name = "Access-Control-Allow-Origin", .value = "*" } } }) catch return error.ResponseFailed;
}

fn text(req: *std.http.Server.Request, body: []const u8, content_type: []const u8, status: std.http.Status) !void {
    req.respond(body, .{ .status = status, .extra_headers = &.{ .{ .name = "Content-Type", .value = content_type }, .{ .name = "Cache-Control", .value = "no-store" }, .{ .name = "Access-Control-Allow-Origin", .value = "*" } } }) catch return error.ResponseFailed;
}

fn errorResponse(req: *std.http.Server.Request, status: std.http.Status, code: []const u8, message: []const u8) !void {
    return json(req, core.ApiError{ .ok = false, .@"error" = code, .message = message }, status);
}

fn readRequestBody(req: *std.http.Server.Request, arena: std.mem.Allocator) ![]u8 {
    var buffer: [4096]u8 = undefined;
    const reader = req.readerExpectNone(&buffer);
    const length = req.head.content_length orelse return error.InvalidBody;
    if (length > 128 * 1024) return error.InvalidBody;
    return reader.readAlloc(arena, @intCast(length));
}

/// Request bodies and everything parsed from them live in the per-request
/// arena and are released when the request finishes. Domain code that keeps
/// a value beyond the request must duplicate it with core.allocator.
fn parseBody(comptime T: type, req: *std.http.Server.Request, arena: std.mem.Allocator) !T {
    const data = try readRequestBody(req, arena);
    return std.json.parseFromSliceLeaky(T, arena, data, .{});
}

fn requireAuth(ctx: *core.Context, req: *std.http.Server.Request) !void {
    if (!auth.isAuthorized(ctx, req)) return error.Unauthorized;
}

fn unauthorized(req: *std.http.Server.Request) !void {
    return errorResponse(req, .unauthorized, "unauthorized", "Sign-in required");
}

fn currentState(ctx: *core.Context) core.State {
    const bt = ctx.bluez.adapter;
    return .{ .alice = .{ .running = false }, .panel = .{ .running = true }, .audio = .{ .volume = ctx.volume }, .led = ctx.lights.state(), .microphone = .{ .stream = "pdm" }, .bluetooth = .{ .name = bt.name, .pairing = bt.pairing and bt.discoverable, .discoverable = bt.discoverable } };
}

fn validAddress(address: []const u8) bool {
    if (address.len != 17) return false;
    for (address, 0..) |char, i| {
        if (i % 3 == 2) { if (char != ':') return false; } else if (!std.ascii.isHex(char)) return false;
    }
    return true;
}

fn authStatus(ctx: *core.Context, req: *std.http.Server.Request) !void {
    return json(req, core.AuthStatus{
        .configured = auth.configured(ctx),
        .owner = ctx.auth.owner,
        .name = core.config.name,
        .passkey_ready = core.config.passkeys,
        .origin = core.config.origin,
        .passkeys = @intCast(ctx.auth.passkeys.items.len),
        .passwords = @intCast(ctx.auth.passwords.items.len + @intFromBool(core.config.password.len > 0)),
    }, .ok);
}

fn passkeyDisabled(req: *std.http.Server.Request) !void {
    return errorResponse(req, .not_found, "passkey_disabled", "Passkeys need PANEL_ORIGIN (HTTPS on a domain)");
}

fn sessionResponse(req: *std.http.Server.Request, token: auth.Token) !void {
    return json(req, core.SessionResponse{ .ok = true, .session = &token }, .ok);
}

fn grantError(req: *std.http.Server.Request, err: anyerror) !void {
    return switch (err) {
        error.InviteRequired => errorResponse(req, .forbidden, "invite_required", "Connect this device from one that is already signed in"),
        error.InvalidInvite => errorResponse(req, .forbidden, "invalid_invite", "The pairing code is wrong or has expired"),
        error.GrantExpired => errorResponse(req, .forbidden, "invite_expired", "The pairing code was used or has expired"),
        error.OwnerRequired => errorResponse(req, .bad_request, "owner_required", "Owner name is required"),
        error.TooManyPasskeys, error.TooManyPasswords => errorResponse(req, .conflict, "too_many_credentials", "Too many sign-in methods, remove an old one first"),
        error.PasswordTooShort => errorResponse(req, .bad_request, "password_too_short", "The password needs at least 8 characters"),
        error.PasswordTooLong => errorResponse(req, .bad_request, "password_too_long", "The password is too long"),
        else => errorResponse(req, .internal_server_error, "save_failed", "Could not store the sign-in method"),
    };
}

/// New password: first credential, new device (invite) or signed-in device.
fn passwordCreate(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator) !void {
    const current = auth.currentSession(ctx, req); // headers first: the body read invalidates them
    const input = parseBody(core.PasswordCreateInput, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected {password, name}");
    const token = auth.createPassword(ctx, current, input) catch |err| return grantError(req, err);
    if (token) |t| return sessionResponse(req, t);
    return json(req, .{ .ok = true }, .ok);
}

fn passwordLogin(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator) !void {
    const input = parseBody(core.PasswordLoginInput, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected {password}");
    const token = auth.passwordLogin(ctx, arena, input.password, input.device) catch |err| switch (err) {
        error.TooManyAttempts => return errorResponse(req, .too_many_requests, "too_many_attempts", "Too many attempts, wait 30 seconds"),
        error.WrongPassword => return errorResponse(req, .unauthorized, "wrong_password", "Wrong password"),
        else => return errorResponse(req, .internal_server_error, "session_failed", "Could not store the session"),
    };
    return sessionResponse(req, token);
}

fn authSession(ctx: *core.Context, req: *std.http.Server.Request) !void {
    if (!auth.isAuthorized(ctx, req)) return unauthorized(req);
    return json(req, core.SessionStatus{ .ok = true, .authenticated = true }, .ok);
}

fn registerOptions(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator) !void {
    if (!core.config.passkeys) return passkeyDisabled(req);
    const current = auth.currentSession(ctx, req); // headers first: the body read invalidates them
    const input = parseBody(core.RegistrationStart, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected {owner} or {invite}");
    const begin = auth.beginRegistration(ctx, current, input) catch |err| return grantError(req, err);
    // Keys already registered: the authenticator refuses to create a duplicate.
    const exclude = try arena.alloc(core.CredentialDescriptor, ctx.auth.passkeys.items.len);
    for (ctx.auth.passkeys.items, exclude) |p, *d| d.* = .{ .id = p.id };
    const params = [_]core.PublicKeyParam{ .{ .type = "public-key", .alg = -7 }, .{ .type = "public-key", .alg = -257 } };
    const owner = try arena.dupe(u8, begin.owner);
    return json(req, core.RegistrationOptions{ .challenge = &begin.challenge, .rp = .{ .name = core.config.name, .id = core.config.rp_id }, .user = .{ .id = "panel-owner", .name = owner, .displayName = owner }, .pubKeyCredParams = &params, .authenticatorSelection = .{ .residentKey = "required", .userVerification = "required" }, .attestation = "none", .excludeCredentials = exclude }, .ok);
}

fn registerVerify(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator) !void {
    if (!core.config.passkeys) return passkeyDisabled(req);
    const input = parseBody(core.RegistrationInput, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Invalid WebAuthn response");
    const token = auth.register(ctx, arena, input) catch |err| return switch (err) {
        error.GrantExpired => grantError(req, err),
        error.AlreadyRegistered => errorResponse(req, .conflict, "already_registered", "This passkey is already registered"),
        else => errorResponse(req, .unauthorized, @errorName(err), "Passkey verification failed"),
    };
    return sessionResponse(req, token);
}

fn loginOptions(ctx: *core.Context, req: *std.http.Server.Request) !void {
    if (!core.config.passkeys) return passkeyDisabled(req);
    const challenge = auth.beginLogin(ctx) catch return errorResponse(req, .not_found, "not_configured", "Register the first passkey first");
    return json(req, core.LoginOptions{ .challenge = &challenge, .rpId = core.config.rp_id, .userVerification = "required" }, .ok);
}

fn loginVerify(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator) !void {
    if (!core.config.passkeys) return passkeyDisabled(req);
    const input = parseBody(core.LoginInput, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Invalid WebAuthn assertion");
    const token = auth.login(ctx, arena, input) catch |err| return errorResponse(req, .unauthorized, @errorName(err), "Passkey verification failed");
    return sessionResponse(req, token);
}

const CredentialView = struct { id: []const u8, type: []const u8, name: []const u8, provider: []const u8, created_s: i64, last_used_s: i64, sessions: u32, current: bool, removable: bool };
const SessionView = struct { id: []const u8, label: []const u8, credential: []const u8, created_s: i64, last_seen_s: i64, current: bool };
const InviteView = struct { code: []const u8, expires_in_s: i64 };
const DevicesView = struct { ok: bool = true, passkey_ready: bool, owner: []const u8, credentials: []const CredentialView, sessions: []const SessionView, invite: ?InviteView, now_s: i64 };

fn credentialName(ctx: *core.Context, id: []const u8) []const u8 {
    if (std.mem.eql(u8, id, auth.env_password_id)) return "Пароль станции";
    if (auth.findPasskey(ctx, id)) |p| return p.name;
    for (ctx.auth.passwords.items) |p| if (std.mem.eql(u8, p.id, id)) return p.name;
    return "";
}

/// Everything the "Устройства и входы" dialog shows.
fn devices(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator, current: *auth.Session) !void {
    const has_env = core.config.password.len > 0;
    const total = ctx.auth.passkeys.items.len + ctx.auth.passwords.items.len + @intFromBool(has_env);
    var list: std.ArrayList(CredentialView) = .empty;
    const sessionsOf = struct {
        fn count(c: *core.Context, id: []const u8) u32 {
            var n: u32 = 0;
            for (c.auth.sessions.items) |s| n += @intFromBool(std.mem.eql(u8, s.credential, id));
            return n;
        }
    }.count;
    for (ctx.auth.passkeys.items) |p| try list.append(arena, .{ .id = p.id, .type = "passkey", .name = p.name, .provider = auth.providerName(p.aaguid) orelse "", .created_s = p.created_s, .last_used_s = p.last_used_s, .sessions = sessionsOf(ctx, p.id), .current = std.mem.eql(u8, p.id, current.credential), .removable = total > 1 });
    for (ctx.auth.passwords.items) |p| try list.append(arena, .{ .id = p.id, .type = "password", .name = p.name, .provider = "", .created_s = p.created_s, .last_used_s = p.last_used_s, .sessions = sessionsOf(ctx, p.id), .current = std.mem.eql(u8, p.id, current.credential), .removable = total > 1 });
    if (has_env) try list.append(arena, .{ .id = auth.env_password_id, .type = "password", .name = credentialName(ctx, auth.env_password_id), .provider = "panel.env", .created_s = 0, .last_used_s = 0, .sessions = sessionsOf(ctx, auth.env_password_id), .current = std.mem.eql(u8, auth.env_password_id, current.credential), .removable = false });
    const sessions = try arena.alloc(SessionView, ctx.auth.sessions.items.len);
    for (ctx.auth.sessions.items, sessions) |*s, *v| {
        v.* = .{ .id = try arena.dupe(u8, &auth.sessionId(s)), .label = s.label, .credential = credentialName(ctx, s.credential), .created_s = s.created_s, .last_seen_s = s.last_seen_s, .current = s == current };
    }
    const invite: ?InviteView = if (auth.activeInvite(ctx)) |i| .{ .code = try arena.dupe(u8, &i.code), .expires_in_s = auth.inviteRemaining(i) } else null;
    return json(req, DevicesView{ .passkey_ready = core.config.passkeys, .owner = ctx.auth.owner, .credentials = list.items, .sessions = sessions, .invite = invite, .now_s = std.time.timestamp() }, .ok);
}

/// /api/v1/auth/* routes that need a signed-in session.
fn accountRoute(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator, action: []const u8) !void {
    const current = auth.currentSession(ctx, req) orelse return unauthorized(req);
    const eql = std.mem.eql;
    if (eql(u8, action, "devices")) return devices(ctx, req, arena, current);
    if (eql(u8, action, "logout")) {
        auth.logout(ctx, current) catch return errorResponse(req, .internal_server_error, "save_failed", "Could not store sessions");
        return json(req, .{ .ok = true }, .ok);
    }
    if (eql(u8, action, "sessions/revoke")) {
        const input = parseBody(struct { id: ?[]const u8 = null }, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected {id} or {}");
        const removed = auth.revokeSessions(ctx, current, input.id) catch return errorResponse(req, .internal_server_error, "save_failed", "Could not store sessions");
        return json(req, .{ .ok = true, .revoked = removed }, .ok);
    }
    if (eql(u8, action, "invite")) {
        const input = parseBody(struct { cancel: bool = false }, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected {} or {cancel:true}");
        if (input.cancel) {
            auth.cancelInvite(ctx);
            return json(req, .{ .ok = true }, .ok);
        }
        const invite = auth.createInvite(ctx);
        return json(req, .{ .ok = true, .code = &invite.code, .expires_in_s = auth.inviteRemaining(invite) }, .ok);
    }
    if (eql(u8, action, "credentials/rename")) {
        const input = parseBody(struct { id: []const u8, name: []const u8 }, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected {id, name}");
        auth.renameCredential(ctx, input.id, input.name) catch |err| return switch (err) {
            error.UnknownCredential => errorResponse(req, .not_found, "unknown_credential", "No such sign-in method"),
            error.EmptyName => errorResponse(req, .bad_request, "empty_name", "Name is empty"),
            else => errorResponse(req, .internal_server_error, "save_failed", "Could not store the change"),
        };
        return json(req, .{ .ok = true }, .ok);
    }
    if (eql(u8, action, "credentials/remove")) {
        const input = parseBody(struct { id: []const u8 }, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected {id}");
        const signed_out = eql(u8, input.id, current.credential);
        auth.removeCredential(ctx, input.id) catch |err| return switch (err) {
            error.LastCredential => errorResponse(req, .conflict, "last_credential", "The last way to sign in cannot be removed"),
            error.ManagedInEnv => errorResponse(req, .conflict, "managed_in_env", "This password is set in panel.env on the station"),
            error.UnknownCredential => errorResponse(req, .not_found, "unknown_credential", "No such sign-in method"),
            else => errorResponse(req, .internal_server_error, "save_failed", "Could not store the change"),
        };
        return json(req, .{ .ok = true, .signed_out = signed_out }, .ok);
    }
    return errorResponse(req, .not_found, "not_found", "Endpoint not found");
}

const TerminalQuery = struct { cols: u16 = 80, rows: u16 = 24, shell: terminal.Shell = .bash };

fn queryValue(query: []const u8, name: []const u8) ?[]const u8 {
    var pairs = std.mem.splitScalar(u8, query, '&');
    while (pairs.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (std.mem.eql(u8, pair[0..eq], name)) return pair[eq + 1 ..];
    }
    return null;
}

fn parseTerminalQuery(target: []const u8) TerminalQuery {
    var out = TerminalQuery{};
    const q = std.mem.indexOfScalar(u8, target, '?') orelse return out;
    const query = target[q + 1 ..];
    if (queryValue(query, "cols")) |v| out.cols = std.fmt.parseInt(u16, v, 10) catch out.cols;
    if (queryValue(query, "rows")) |v| out.rows = std.fmt.parseInt(u16, v, 10) catch out.rows;
    if (queryValue(query, "shell")) |v| out.shell = terminal.Shell.parse(v);
    return out;
}

/// PTY -> WebSocket. Runs until the shell exits or the reader asks it to stop.
fn terminalPump(ctx: *core.Context, owner: [32]u8, session: *terminal.Session, ws: *std.http.Server.WebSocket) void {
    var buffer: [16 * 1024]u8 = undefined;
    var epoch = ctx.auth.epoch.load(.acquire);
    while (!session.stopping.load(.acquire)) {
        // Signed out elsewhere (logout, revoked device): close the shell.
        if (!auth.stillSignedIn(ctx, owner, &epoch)) {
            ws.writeMessage("\r\n[signed out]\r\n", .binary) catch {};
            ws.writeMessage(&.{ 0x0f, 0xa1 }, .connection_close) catch {}; // 4001 = signed out
            return;
        }
        const count = session.readInto(&buffer, 100) catch {
            ws.writeMessage("\r\n[shell exited]\r\n", .binary) catch {};
            ws.writeMessage(&.{ 0x03, 0xe8 }, .connection_close) catch {};
            return;
        };
        if (count == 0) continue;
        ws.writeMessage(buffer[0..count], .binary) catch return;
    }
}

pub fn handleTerminalWebSocket(ctx: *core.Context, req: *std.http.Server.Request) !void {
    ctx.mutex.lock();
    const owner = auth.webSocketSession(ctx, req);
    ctx.mutex.unlock();
    if (owner == null) return unauthorized(req);
    const query = parseTerminalQuery(req.head.target);
    const key = switch (req.upgradeRequested()) { .websocket => |value| value orelse return error.InvalidWebSocket, else => return error.InvalidWebSocket };
    var session = try terminal.Session.spawn(query.shell, query.cols, query.rows);
    var ws = req.respondWebSocket(.{ .key = key, .extra_headers = &.{.{ .name = "Sec-WebSocket-Protocol", .value = auth.ws_protocol }} }) catch |err| { session.close(); return err; };
    ws.flush() catch |err| { session.close(); return err; };
    const pump = std.Thread.spawn(.{}, terminalPump, .{ ctx, owner.?, &session, &ws }) catch |err| { session.close(); return err; };
    defer {
        session.stopping.store(true, .release);
        pump.join();
        session.close();
    }
    var resize_buf: [256]u8 = undefined;
    while (true) {
        const message = ws.readSmallMessage() catch break;
        if (message.opcode == .ping or message.opcode == .pong) continue;
        if (message.data.len == 0) continue;
        // Control messages are JSON text frames; keystrokes are sent as binary.
        if (message.opcode == .text and message.data[0] == '{' and message.data.len < resize_buf.len) {
            var fba = std.heap.FixedBufferAllocator.init(&resize_buf);
            const Resize = struct { type: []const u8, cols: u16, rows: u16 };
            if (std.json.parseFromSliceLeaky(Resize, fba.allocator(), message.data, .{ .ignore_unknown_fields = true })) |msg| {
                if (std.mem.eql(u8, msg.type, "resize")) session.resize(msg.cols, msg.rows);
                continue;
            } else |_| {}
        }
        session.write(message.data) catch break;
    }
}

/// Runs `action` without the context lock (dbus-send/amixer can take seconds),
/// then asks the sampler to re-read BlueZ right away.
fn unlocked(ctx: *core.Context, comptime action: anytype, args: anytype) @typeInfo(@TypeOf(action)).@"fn".return_type.? {
    ctx.mutex.unlock();
    defer ctx.mutex.lock();
    defer ctx.refresh_requested.store(true, .release);
    return @call(.auto, action, args);
}

pub fn handle(ctx: *core.Context, req: *std.http.Server.Request, arena: std.mem.Allocator) !void {
    // A POST without Content-Length or Transfer-Encoding ("curl -X POST") has
    // an empty body; std.http asserts one of them exists when it discards
    // the body after the response, which aborted the whole server.
    if (req.head.method.requestHasBody() and req.head.transfer_encoding == .none and req.head.content_length == null) req.head.content_length = 0;
    const target = req.head.target;
    const eql = std.mem.eql;
    if (eql(u8, target, "/") or eql(u8, target, "/index.html")) return text(req, index_html, "text/html; charset=utf-8", .ok);
    if (std.mem.startsWith(u8, target, "/assets/")) return asset(req, target["/assets/".len..]);
    if (eql(u8, target, "/api/v1/health")) return json(req, core.Health{ .ok = true, .service = "alisa-panel", .version = version }, .ok);
    if (eql(u8, target, "/api/v1/auth/status")) return authStatus(ctx, req);
    if (eql(u8, target, "/api/v1/auth/session")) return authSession(ctx, req);
    if (eql(u8, target, "/api/v1/auth/register/options")) return registerOptions(ctx, req, arena);
    if (eql(u8, target, "/api/v1/auth/register/verify")) return registerVerify(ctx, req, arena);
    if (eql(u8, target, "/api/v1/auth/login/options")) return loginOptions(ctx, req);
    if (eql(u8, target, "/api/v1/auth/login/verify")) return loginVerify(ctx, req, arena);
    if (eql(u8, target, "/api/v1/auth/password/login")) return passwordLogin(ctx, req, arena);
    if (eql(u8, target, "/api/v1/auth/password/create")) return passwordCreate(ctx, req, arena);
    if (std.mem.startsWith(u8, target, "/api/v1/auth/")) return accountRoute(ctx, req, arena, target["/api/v1/auth/".len..]);
    if (eql(u8, target, "/api/v1/dashboard")) {
        // Device names, track titles and metrics are private too.
        requireAuth(ctx, req) catch return unauthorized(req);
        ctx.last_dashboard_s.store(@intCast(std.time.timestamp()), .release);
        const history = metrics.history(ctx, arena) catch return errorResponse(req, .internal_server_error, "metrics_unavailable", "Metrics are unavailable");
        const current = if (history.len > 0) history[history.len - 1] else metrics.read(ctx) catch return errorResponse(req, .service_unavailable, "metrics_unavailable", "Metrics are unavailable");
        return json(req, core.DashboardSnapshot{
            .health = .{ .ok = true, .service = "alisa-panel", .version = version },
            .capabilities = .{ .audio = .{ .volume = true, .analyser = true }, .led = .{ .control = true, .zones = 3, .modes = true }, .microphone = .{ .monitoring = true, .reason = "pdm_raw" }, .media = true },
            .state = currentState(ctx),
            .metrics = current,
            .metrics_history = history,
            .bluetooth_devices = ctx.bluez.devices,
            .media = ctx.bluez.media,
            .system = ctx.system,
            .layout_revision = ctx.layout.revision,
        }, .ok);
    }
    if (eql(u8, target, "/api/v1/layout")) {
        requireAuth(ctx, req) catch return unauthorized(req);
        if (req.head.method == .GET) return text(req, try layout.response(ctx, arena), "application/json; charset=utf-8", .ok);
        const body = readRequestBody(req, arena) catch return errorResponse(req, .payload_too_large, "too_large", "Layout is too large");
        const revision = layout.set(ctx, arena, body) catch |err| return switch (err) {
            error.InvalidLayout => errorResponse(req, .bad_request, "invalid_layout", "Expected {layout: {...}}"),
            error.LayoutTooLarge => errorResponse(req, .payload_too_large, "too_large", "Layout is too large"),
            else => errorResponse(req, .internal_server_error, "save_failed", "Could not store the layout"),
        };
        return json(req, .{ .ok = true, .revision = revision }, .ok);
    }

    if (eql(u8, target, "/api/v1/led/color")) {
        requireAuth(ctx, req) catch return unauthorized(req);
        const input = parseBody(core.LedInput, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected r, g, b, brightness");
        const off = input.brightness == 0 or (input.r == 0 and input.g == 0 and input.b == 0);
        const current = ctx.lights.get();
        // Picking a colour keeps the current animation/music mode (it is their base
        // colour); "off" keeps the colour for the next "on".
        const mode: []const u8 = if (off) "off" else if (current.mode == .off) "static" else @tagName(current.mode);
        _ = ctx.lights.apply(if (off) .{ .mode = mode } else .{ .mode = mode, .r = input.r, .g = input.g, .b = input.b, .brightness = input.brightness }) catch return errorResponse(req, .bad_request, "invalid_mode", "Invalid light mode");
        return json(req, .{ .ok = true, .led = ctx.lights.state() }, .ok);
    }
    if (eql(u8, target, "/api/v1/led/mode")) {
        requireAuth(ctx, req) catch return unauthorized(req);
        const input = parseBody(core.LedModeInput, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected mode/algo/colour fields");
        _ = ctx.lights.apply(input) catch return errorResponse(req, .bad_request, "invalid_mode", "Unknown mode or algorithm");
        return json(req, .{ .ok = true, .led = ctx.lights.state() }, .ok);
    }
    if (eql(u8, target, "/api/v1/audio/volume")) {
        requireAuth(ctx, req) catch return unauthorized(req);
        const input = parseBody(core.VolumeInput, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected volume 0..100");
        const level = @min(input.volume, 100);
        unlocked(ctx, audio.setVolume, .{level}) catch return errorResponse(req, .service_unavailable, "volume_unavailable", "amixer failed");
        ctx.volume = level;
        return json(req, .{ .ok = true, .volume = level }, .ok);
    }
    if (std.mem.startsWith(u8, target, "/api/v1/media/")) {
        requireAuth(ctx, req) catch return unauthorized(req);
        const action = std.meta.stringToEnum(bluez.MediaAction, target["/api/v1/media/".len..]) orelse return errorResponse(req, .not_found, "not_found", "Unknown media action");
        if (ctx.bluez.player_path.len == 0) return errorResponse(req, .conflict, "no_player", "No Bluetooth source with media controls");
        const path = try arena.dupe(u8, ctx.bluez.player_path);
        unlocked(ctx, bluez.mediaAction, .{ path, action }) catch return errorResponse(req, .service_unavailable, "media_failed", "The source rejected the command");
        return json(req, .{ .ok = true, .action = @tagName(action) }, .ok);
    }
    if (eql(u8, target, "/api/v1/bluetooth/pairing/start") or eql(u8, target, "/api/v1/bluetooth/pairing/stop")) {
        requireAuth(ctx, req) catch return unauthorized(req);
        const enabled = std.mem.endsWith(u8, target, "start");
        unlocked(ctx, bluez.setPairing, .{enabled}) catch return errorResponse(req, .service_unavailable, "bluetooth_unavailable", "Could not change pairing");
        return json(req, .{ .ok = true, .pairing = enabled }, .ok);
    }
    if (std.mem.startsWith(u8, target, bluetooth_prefix)) {
        requireAuth(ctx, req) catch return unauthorized(req);
        const action = std.meta.stringToEnum(bluez.DeviceAction, target[bluetooth_prefix.len..]) orelse return errorResponse(req, .not_found, "not_found", "Endpoint not found");
        const input = parseBody(core.BluetoothAction, req, arena) catch return errorResponse(req, .bad_request, "invalid_body", "Expected Bluetooth address");
        if (!validAddress(input.address)) return errorResponse(req, .bad_request, "invalid_address", "Invalid Bluetooth address");
        unlocked(ctx, bluez.deviceAction, .{ action, input.address }) catch return errorResponse(req, .service_unavailable, "bluetooth_unavailable", "BlueZ rejected the request");
        return json(req, .{ .ok = true, .address = input.address, .action = @tagName(action) }, .ok);
    }
    return errorResponse(req, .not_found, "not_found", "Endpoint not found");
}

/// Public static files from $PANEL_WEB_ROOT/assets (logo for the image
/// widget, wallpapers). Flat names only: no directories, no dot-files.
fn asset(req: *std.http.Server.Request, name: []const u8) !void {
    const valid = name.len > 0 and name.len <= 128 and name[0] != '.' and for (name) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '.' or c == '-' or c == '_')) break false;
    } else true;
    if (!valid) return text(req, "not found", "text/plain", .not_found);
    const path = try std.fs.path.join(core.allocator, &.{ core.config.web_root, "assets", name });
    defer core.allocator.free(path);
    const file = std.fs.openFileAbsolute(path, .{}) catch return text(req, "not found", "text/plain", .not_found);
    defer file.close();
    const data = file.readToEndAlloc(core.allocator, 8 * 1024 * 1024) catch return text(req, "too large", "text/plain", .internal_server_error);
    defer core.allocator.free(data);
    const types = [_]struct { ext: []const u8, mime: []const u8 }{ .{ .ext = ".png", .mime = "image/png" }, .{ .ext = ".jpg", .mime = "image/jpeg" }, .{ .ext = ".jpeg", .mime = "image/jpeg" }, .{ .ext = ".webp", .mime = "image/webp" }, .{ .ext = ".gif", .mime = "image/gif" }, .{ .ext = ".svg", .mime = "image/svg+xml" } };
    var mime: []const u8 = "application/octet-stream";
    for (types) |t| {
        if (std.ascii.endsWithIgnoreCase(name, t.ext)) mime = t.mime;
    }
    // CSP: an SVG opened directly must not run scripts on the panel origin.
    req.respond(data, .{ .status = .ok, .extra_headers = &.{ .{ .name = "Content-Type", .value = mime }, .{ .name = "Cache-Control", .value = "public, max-age=3600" }, .{ .name = "X-Content-Type-Options", .value = "nosniff" }, .{ .name = "Content-Security-Policy", .value = "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } } }) catch return error.ResponseFailed;
}

const bluetooth_prefix = "/api/v1/bluetooth/";
const version = "0.6.0";

