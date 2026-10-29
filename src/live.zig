//! /api/v1/live/ws - one WebSocket per browser tab for real-time data.
//!   server -> client, binary: analyser frames (audio.frame_len bytes, layout
//!                             in audio.zig) for every subscribed source
//!   server -> client, text:   {"type":"media","media":{...}} whenever the
//!                             AVRCP state changes (and on subscribe)
//!   client -> server, text:   {"type":"subscribe","playback":bool,"mic":bool,"media":bool}
//! Audio capture runs only while at least one subscriber (or the light
//! engine) needs a source.
const std = @import("std");
const core = @import("core.zig");
const audio = @import("audio.zig");
const auth = @import("auth.zig");

const Subscription = struct {
    sources: [2]std.atomic.Value(bool) = .{ .init(false), .init(false) },
    media: std.atomic.Value(bool) = .init(false),
    stopping: std.atomic.Value(bool) = .init(false),
};

const SubscribeMessage = struct { type: []const u8, playback: bool = false, mic: bool = false, media: bool = false };

pub fn handle(ctx: *core.Context, hub: *audio.Hub, req: *std.http.Server.Request) !void {
    ctx.mutex.lock();
    const authorized = auth.isWebSocketAuthorized(ctx, req);
    ctx.mutex.unlock();
    if (!authorized) {
        req.respond("{\"ok\":false,\"error\":\"unauthorized\",\"message\":\"Passkey session required\"}", .{ .status = .unauthorized, .extra_headers = &.{.{ .name = "Content-Type", .value = "application/json" }} }) catch {};
        return;
    }
    const key = switch (req.upgradeRequested()) {
        .websocket => |value| value orelse return error.InvalidWebSocket,
        else => return error.InvalidWebSocket,
    };
    var ws = try req.respondWebSocket(.{ .key = key, .extra_headers = &.{.{ .name = "Sec-WebSocket-Protocol", .value = auth.ws_protocol }} });
    try ws.flush();

    var sub = Subscription{};
    const sender = try std.Thread.spawn(.{}, sendLoop, .{ ctx, hub, &ws, &sub });
    defer {
        sub.stopping.store(true, .release);
        sender.join();
        for ([_]audio.Source{ .playback, .mic }) |source| {
            if (sub.sources[@intFromEnum(source)].load(.acquire)) hub.release(source);
        }
        if (sub.media.load(.acquire)) _ = ctx.media_subscribers.fetchSub(1, .acq_rel);
    }

    var scratch: [512]u8 = undefined;
    while (true) {
        const message = ws.readSmallMessage() catch break;
        if (message.opcode != .text or message.data.len == 0 or message.data[0] != '{' or message.data.len > scratch.len / 2) continue;
        var fba = std.heap.FixedBufferAllocator.init(&scratch);
        const parsed = std.json.parseFromSliceLeaky(SubscribeMessage, fba.allocator(), message.data, .{ .ignore_unknown_fields = true }) catch continue;
        if (!std.mem.eql(u8, parsed.type, "subscribe")) continue;
        const wanted = [2]bool{ parsed.playback, parsed.mic };
        for ([_]audio.Source{ .playback, .mic }) |source| {
            const slot = &sub.sources[@intFromEnum(source)];
            const had = slot.load(.acquire);
            const want = wanted[@intFromEnum(source)];
            if (want and !had) hub.acquire(source);
            if (!want and had) hub.release(source);
            slot.store(want, .release);
        }
        const had_media = sub.media.load(.acquire);
        if (parsed.media and !had_media) _ = ctx.media_subscribers.fetchAdd(1, .acq_rel);
        if (!parsed.media and had_media) _ = ctx.media_subscribers.fetchSub(1, .acq_rel);
        sub.media.store(parsed.media, .release);
        if (parsed.media and !had_media) ctx.refresh_requested.store(true, .release);
    }
}

fn sendLoop(ctx: *core.Context, hub: *audio.Hub, ws: *std.http.Server.WebSocket, sub: *Subscription) void {
    var seen: u64 = 0;
    var sent = [2]u64{ 0, 0 };
    const never = std.math.maxInt(u32);
    var sent_media: u32 = never;
    var frame: [audio.frame_len]u8 = undefined;
    while (!sub.stopping.load(.acquire)) {
        seen = hub.waitNewer(seen, 250 * std.time.ns_per_ms);
        for ([_]audio.Source{ .playback, .mic }) |source| {
            const i = @intFromEnum(source);
            if (!sub.sources[i].load(.acquire)) continue;
            const seq = hub.copyFrame(source, &frame);
            if (seq == 0 or seq == sent[i]) continue;
            ws.writeMessage(&frame, .binary) catch return;
            sent[i] = seq;
        }
        if (!sub.media.load(.acquire)) {
            sent_media = never;
            continue;
        }
        const media_seq = ctx.media_seq.load(.acquire);
        if (media_seq == sent_media) continue;
        ctx.mutex.lock();
        const body = std.fmt.allocPrint(core.allocator, "{f}", .{std.json.fmt(.{ .type = "media", .media = ctx.bluez.media }, .{})}) catch null;
        ctx.mutex.unlock();
        const text = body orelse continue;
        defer core.allocator.free(text);
        ws.writeMessage(text, .text) catch return;
        sent_media = media_seq;
    }
}
