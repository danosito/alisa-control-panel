const std = @import("std");
const builtin = @import("builtin");
const tls = @import("tls");
const core = @import("core.zig");
const config = @import("config.zig");
const auth = @import("auth.zig");
const http = @import("http.zig");
const metrics = @import("metrics.zig");
const audio = @import("audio.zig");
const lights = @import("lights.zig");
const bluez = @import("bluez.zig");
const live = @import("live.zig");

fn acceptCompat(server: *std.net.Server) anyerror!std.net.Server.Connection {
    if (builtin.os.tag != .linux) return server.accept();
    var address: std.net.Address = undefined;
    var address_len: std.posix.socklen_t = @sizeOf(std.net.Address);
    while (true) {
        const rc = std.os.linux.syscall3(.accept, @intCast(server.stream.handle), @intFromPtr(&address.any), @intFromPtr(&address_len));
        switch (std.posix.errno(rc)) {
            .SUCCESS => return .{ .stream = .{ .handle = @intCast(rc) }, .address = address },
            .INTR => continue,
            else => |err| return std.posix.unexpectedErrno(err),
        }
    }
}

fn serveHttp(stream: anytype, ctx: *core.Context) void {
    var recv_buffer: [16 * 1024]u8 = undefined;
    var send_buffer: [16 * 1024]u8 = undefined;
    var reader = stream.reader(&recv_buffer);
    var writer = stream.writer(&send_buffer);
    const input = if (@hasField(@TypeOf(reader), "interface")) &reader.interface else reader.interface();
    const output = &writer.interface;
    var server: std.http.Server = .init(input, output);
    while (true) {
        var request = server.receiveHead() catch return;
        if (std.mem.startsWith(u8, request.head.target, "/api/v1/terminal/ws")) {
            // Long-lived: owns its own PTY session and must not hold ctx.mutex.
            http.handleTerminalWebSocket(ctx, &request) catch |err| std.log.err("terminal websocket failed: {t}", .{err});
            return;
        }
        if (std.mem.startsWith(u8, request.head.target, "/api/v1/live/ws")) {
            live.handle(ctx, ctx.hub, &request) catch |err| std.log.err("live websocket failed: {t}", .{err});
            return;
        }
        var arena = std.heap.ArenaAllocator.init(core.allocator);
        defer arena.deinit();
        ctx.mutex.lock();
        defer ctx.mutex.unlock();
        http.handle(ctx, &request, arena.allocator()) catch return;
        if (!request.head.keep_alive) return;
    }
}

fn serveConnection(tcp: std.net.Server.Connection, tls_config: ?*tls.config.CertKeyPair, ctx: *core.Context) void {
    defer tcp.stream.close();
    // Interactive traffic (terminal echo, live frames) is many tiny writes:
    // without TCP_NODELAY Nagle + delayed ACKs add 40-200 ms per keystroke.
    std.posix.setsockopt(tcp.stream.handle, std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, &std.mem.toBytes(@as(c_int, 1))) catch {};
    const cert = tls_config orelse {
        // PANEL_TLS=off: plain HTTP (LAN, or behind a TLS-terminating proxy).
        serveHttp(tcp.stream, ctx);
        return;
    };
    var secure = tls.serverFromStream(tcp.stream, .{ .auth = cert }) catch |err| { std.log.err("TLS handshake failed: {t}", .{err}); return; };
    defer secure.close() catch {};
    serveHttp(&secure, ctx);
}

pub fn main() !void {
    core.config = config.load() catch std.process.exit(2);
    var ctx = core.Context{};
    auth.load(&ctx);
    var hub = audio.Hub{};
    var engine = lights.Engine.init(&hub);
    ctx.hub = &hub;
    ctx.lights = &engine;
    ctx.volume = audio.readVolume();
    bluez.refresh(&ctx);
    try engine.start();
    const sampler = try std.Thread.spawn(.{}, metrics.sampleLoop, .{&ctx});
    sampler.detach();
    const cfg = &core.config;
    var cert: tls.config.CertKeyPair = undefined;
    var tls_config: ?*tls.config.CertKeyPair = null;
    if (cfg.tls) {
        cert = tls.config.CertKeyPair.fromFilePathAbsolute(core.allocator, cfg.tls_cert, cfg.tls_key) catch |err| {
            std.log.err("cannot load TLS certificate {s} / key {s}: {t}", .{ cfg.tls_cert, cfg.tls_key, err });
            std.process.exit(2);
        };
        tls_config = &cert;
    }
    defer if (tls_config) |c| c.deinit(core.allocator);
    var address = try std.net.Address.parseIp4(cfg.bind, cfg.port);
    var server = try address.listen(.{ .reuse_address = true });
    defer server.deinit();
    std.log.info("{s}: listening on {s}://{s}:{d}, auth {t}", .{ cfg.name, if (cfg.tls) "https" else "http", cfg.bind, cfg.port, cfg.auth });
    while (true) {
        const tcp = acceptCompat(&server) catch |err| { std.log.err("accept failed: {t}", .{err}); continue; };
        const thread = std.Thread.spawn(.{}, serveConnection, .{ tcp, tls_config, &ctx }) catch |err| { std.log.err("connection thread failed: {t}", .{err}); tcp.stream.close(); continue; };
        thread.detach();
    }
}
