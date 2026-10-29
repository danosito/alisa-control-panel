const std = @import("std");
const core = @import("core.zig");
const bluez = @import("bluez.zig");

fn readProc(path: []const u8, buffer: []u8) ![]u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();
    const count = try file.readAll(buffer);
    return buffer[0..count];
}

fn readTemp() f32 {
    var buffer: [32]u8 = undefined;
    const data = readProc("/sys/class/thermal/thermal_zone0/temp", &buffer) catch return 0;
    const milli = std.fmt.parseInt(i64, std.mem.trim(u8, data, " \r\n"), 10) catch return 0;
    return @as(f32, @floatFromInt(milli)) / 1000.0;
}

/// wlan0 rx/tx byte counters from /proc/net/dev.
fn readNet() ?struct { rx: u64, tx: u64 } {
    var buffer: [4096]u8 = undefined;
    const data = readProc("/proc/net/dev", &buffer) catch return null;
    var lines = std.mem.splitScalar(u8, data, '\n');
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        if (!std.mem.eql(u8, std.mem.trim(u8, line[0..colon], " "), "wlan0")) continue;
        var fields = std.mem.tokenizeAny(u8, line[colon + 1 ..], " \t");
        var values: [9]u64 = .{0} ** 9;
        for (&values) |*v| v.* = std.fmt.parseInt(u64, fields.next() orelse "0", 10) catch 0;
        return .{ .rx = values[0], .tx = values[8] };
    }
    return null;
}

/// Takes one sample; caller holds ctx.mutex.
pub fn read(ctx: *core.Context) !core.Metrics {
    var stat_buf: [4096]u8 = undefined;
    const stat = try readProc("/proc/stat", &stat_buf);
    var lines = std.mem.splitScalar(u8, stat, '\n');
    const cpu_line = lines.next() orelse return error.InvalidProcStat;
    var fields = std.mem.tokenizeAny(u8, cpu_line, " \t");
    _ = fields.next();
    var values: [8]u64 = .{0} ** 8;
    for (&values) |*value| value.* = std.fmt.parseInt(u64, fields.next() orelse "0", 10) catch 0;
    var total: u64 = 0;
    for (values) |value| total += value;
    const idle = values[3] + values[4];
    var cpu_percent: f32 = 0;
    if (ctx.previous_cpu_total != 0 and total > ctx.previous_cpu_total) {
        const total_delta = total - ctx.previous_cpu_total;
        const idle_delta = idle - ctx.previous_cpu_idle;
        cpu_percent = @as(f32, @floatFromInt(total_delta - @min(total_delta, idle_delta))) * 100.0 / @as(f32, @floatFromInt(total_delta));
    }
    ctx.previous_cpu_total = total;
    ctx.previous_cpu_idle = idle;

    var mem_buf: [8192]u8 = undefined;
    const mem = try readProc("/proc/meminfo", &mem_buf);
    var total_kb: u64 = 0;
    var available_kb: u64 = 0;
    var mem_lines = std.mem.splitScalar(u8, mem, '\n');
    while (mem_lines.next()) |line| {
        var parts = std.mem.tokenizeAny(u8, line, " :\t");
        const key = parts.next() orelse continue;
        const value = std.fmt.parseInt(u64, parts.next() orelse continue, 10) catch continue;
        if (std.mem.eql(u8, key, "MemTotal")) total_kb = value;
        if (std.mem.eql(u8, key, "MemAvailable")) available_kb = value;
    }

    var rx_kbps: f32 = 0;
    var tx_kbps: f32 = 0;
    const now = std.time.milliTimestamp();
    if (readNet()) |net| {
        const prev = ctx.previous_net;
        if (prev.ms != 0 and now > prev.ms and net.rx >= prev.rx and net.tx >= prev.tx) {
            const seconds = @as(f32, @floatFromInt(now - prev.ms)) / 1000.0;
            rx_kbps = @as(f32, @floatFromInt(net.rx - prev.rx)) * 8.0 / 1000.0 / seconds;
            tx_kbps = @as(f32, @floatFromInt(net.tx - prev.tx)) * 8.0 / 1000.0 / seconds;
        }
        ctx.previous_net = .{ .rx = net.rx, .tx = net.tx, .ms = now };
    }

    const sample = core.Metrics{ .cpu_percent = cpu_percent, .ram_used_mb = @intCast((total_kb -| available_kb) / 1024), .ram_total_mb = @intCast(total_kb / 1024), .temp_c = readTemp(), .net_rx_kbps = rx_kbps, .net_tx_kbps = tx_kbps };
    ctx.metrics_history[ctx.metrics_history_next] = sample;
    ctx.metrics_history_next = (ctx.metrics_history_next + 1) % ctx.metrics_history.len;
    if (ctx.metrics_history_len < ctx.metrics_history.len) ctx.metrics_history_len += 1;
    return sample;
}

/// Copies the ring buffer oldest-first into `arena` (request lifetime).
pub fn history(ctx: *const core.Context, arena: std.mem.Allocator) ![]core.Metrics {
    const count = ctx.metrics_history_len;
    const output = try arena.alloc(core.Metrics, count);
    const start = if (count == ctx.metrics_history.len) ctx.metrics_history_next else 0;
    for (0..count) |index| output[index] = ctx.metrics_history[(start + index) % ctx.metrics_history.len];
    return output;
}

// glibc's struct statvfs64 on 32-bit ARM (+ slack for safety).
const Statvfs64 = extern struct { bsize: c_ulong, frsize: c_ulong, blocks: u64, bfree: u64, bavail: u64, files: u64, ffree: u64, favail: u64, fsid: c_ulong, unused: c_int, flag: c_ulong, namemax: c_ulong, spare: [6]c_int, slack: [16]c_int };
extern fn statvfs64(path: [*:0]const u8, buf: *Statvfs64) c_int;

/// Uptime, load, temperature, Wi-Fi and free space on the data partition.
fn system() core.SystemInfo {
    var info = core.SystemInfo{ .temp_c = readTemp() };
    var buffer: [1024]u8 = undefined;
    if (readProc("/proc/uptime", &buffer)) |data| {
        const end = std.mem.indexOfAny(u8, data, ". ") orelse data.len;
        info.uptime_s = std.fmt.parseInt(u64, data[0..end], 10) catch 0;
    } else |_| {}
    if (readProc("/proc/loadavg", &buffer)) |data| {
        var parts = std.mem.tokenizeScalar(u8, data, ' ');
        for (&info.load) |*l| l.* = std.fmt.parseFloat(f32, parts.next() orelse "0") catch 0;
    } else |_| {}
    if (readProc("/proc/net/wireless", &buffer)) |data| {
        var lines = std.mem.splitScalar(u8, data, '\n');
        while (lines.next()) |line| {
            const colon = std.mem.indexOf(u8, line, "wlan0:") orelse continue;
            var parts = std.mem.tokenizeAny(u8, line[colon + 6 ..], " .\t");
            _ = parts.next(); // status
            const quality = std.fmt.parseInt(u32, parts.next() orelse "0", 10) catch 0;
            info.wifi_quality = @intCast(@min(100, quality * 100 / 70));
            info.wifi_rssi = std.fmt.parseInt(i32, parts.next() orelse "0", 10) catch 0;
        }
    } else |_| {}
    var vfs: Statvfs64 = undefined;
    if (statvfs64("/bkupgrade", &vfs) == 0) {
        const block: u64 = if (vfs.frsize != 0) vfs.frsize else vfs.bsize;
        info.disk_total_mb = @intCast(vfs.blocks * block / (1024 * 1024));
        info.disk_free_mb = @intCast(vfs.bavail * block / (1024 * 1024));
    }
    return info;
}

/// One sample per second. BlueZ is polled every second while someone looks
/// at the dashboard or listens for media events, every 10 s otherwise, and
/// right away after an action. dbus-send runs outside the context lock.
pub fn sampleLoop(ctx: *core.Context) void {
    var tick: u32 = 0;
    var last_bluez_ms: i64 = 0;
    while (true) : (tick +%= 1) {
        var slept: u32 = 0;
        while (slept < 10 and !ctx.refresh_requested.load(.acquire)) : (slept += 1) std.Thread.sleep(100 * std.time.ns_per_ms);
        const info = system();
        ctx.mutex.lock();
        _ = read(ctx) catch {};
        ctx.system = info;
        ctx.mutex.unlock();

        const now = std.time.milliTimestamp();
        const active = ctx.media_subscribers.load(.acquire) > 0 or std.time.timestamp() - @as(i64, ctx.last_dashboard_s.load(.acquire)) < 15;
        const due_ms: i64 = if (active) 900 else 10_000;
        if (ctx.refresh_requested.swap(false, .acq_rel) or now - last_bluez_ms >= due_ms) {
            bluez.refresh(ctx);
            last_bluez_ms = std.time.milliTimestamp();
        }
    }
}
