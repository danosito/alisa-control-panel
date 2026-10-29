//! LED ring engine: runs on the speaker, independent of any browser.
//! Three RGB zones (aw9110 behind /sys/class/leds/plum:{red,green,blue}:ring{1,2,3}).
//!
//! Modes: off, static, breathe, rainbow, candle and music. Music mode follows
//! the playback loopback analyser with one of four algorithms:
//!   pulse    - brightness follows loudness
//!   spectrum - zone 1 bass, zone 2 mids, zone 3 treble
//!   beat     - flashes on beats, hue and lead zone advance every beat
//!   flow     - hue follows the spectral centroid, brightness the loudness
//! The configuration persists in $PANEL_DATA_DIR/lights.json.
const std = @import("std");
const core = @import("core.zig");
const audio = @import("audio.zig");

pub const Mode = enum { off, static, breathe, rainbow, candle, music };
pub const Algo = enum { pulse, spectrum, beat, flow };

pub const Config = struct {
    mode: Mode = .static,
    algo: Algo = .pulse,
    r: u8 = 255,
    g: u8 = 140,
    b: u8 = 40,
    brightness: u8 = 200,
    /// 1..100: animation / decay speed.
    speed: u8 = 50,
    /// 1..100: how strongly music drives the LEDs.
    sensitivity: u8 = 50,
};

const Rgb = struct { r: f32, g: f32, b: f32 };
const frame_ns = 33 * std.time.ns_per_ms;

pub const Engine = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    config: Config = .{},
    version: u64 = 0,
    hub: *audio.Hub,
    fds: [9]?std.posix.fd_t = [_]?std.posix.fd_t{null} ** 9,
    written: [9]i16 = [_]i16{-1} ** 9,

    pub fn init(hub: *audio.Hub) Engine {
        var engine = Engine{ .hub = hub };
        engine.config = load() orelse fromHardware();
        return engine;
    }

    pub fn start(engine: *Engine) !void {
        const thread = try std.Thread.spawn(.{}, loop, .{engine});
        thread.detach();
    }

    pub fn get(engine: *Engine) Config {
        engine.mutex.lock();
        defer engine.mutex.unlock();
        return engine.config;
    }

    pub fn set(engine: *Engine, config: Config) void {
        engine.mutex.lock();
        engine.config = config;
        engine.version += 1;
        engine.cond.signal();
        engine.mutex.unlock();
        save(config);
    }

    /// Applies a partial update from the API.
    pub fn apply(engine: *Engine, input: core.LedModeInput) !Config {
        var next = engine.get();
        if (input.mode) |value| next.mode = std.meta.stringToEnum(Mode, value) orelse return error.InvalidMode;
        if (input.algo) |value| next.algo = std.meta.stringToEnum(Algo, value) orelse return error.InvalidAlgo;
        if (input.r) |v| next.r = v;
        if (input.g) |v| next.g = v;
        if (input.b) |v| next.b = v;
        if (input.brightness) |v| next.brightness = v;
        if (input.speed) |v| next.speed = std.math.clamp(v, 1, 100);
        if (input.sensitivity) |v| next.sensitivity = std.math.clamp(v, 1, 100);
        engine.set(next);
        return next;
    }

    pub fn state(engine: *Engine) core.LedState {
        const c = engine.get();
        return .{ .mode = @tagName(c.mode), .algo = @tagName(c.algo), .color = .{ .r = c.r, .g = c.g, .b = c.b, .brightness = c.brightness }, .speed = c.speed, .sensitivity = c.sensitivity };
    }

    fn loop(engine: *Engine) void {
        var music = MusicState{};
        var candle = [3]f32{ 0.8, 0.8, 0.8 };
        var prng = std.Random.DefaultPrng.init(@intCast(std.time.milliTimestamp()));
        var listening = false;
        const started = std.time.milliTimestamp();
        while (true) {
            engine.mutex.lock();
            const config = engine.config;
            const version = engine.version;
            engine.mutex.unlock();

            const wants_audio = config.mode == .music;
            if (wants_audio and !listening) engine.hub.acquire(.playback);
            if (!wants_audio and listening) engine.hub.release(.playback);
            listening = wants_audio;

            const t = @as(f32, @floatFromInt(std.time.milliTimestamp() - started)) / 1000.0;
            const speed = @as(f32, @floatFromInt(config.speed)) / 100.0;
            const base = Rgb{ .r = @floatFromInt(config.r), .g = @floatFromInt(config.g), .b = @floatFromInt(config.b) };
            var zones: [3]Rgb = undefined;
            var animated = true;
            switch (config.mode) {
                .off => {
                    zones = .{ black, black, black };
                    animated = false;
                },
                .static => {
                    zones = .{ base, base, base };
                    animated = false;
                },
                .breathe => {
                    const period = 8.0 - 6.5 * speed;
                    const v = 0.08 + 0.92 * (0.5 - 0.5 * @cos(2.0 * std.math.pi * t / period));
                    zones = .{ scale(base, v), scale(base, v), scale(base, v) };
                },
                .rainbow => {
                    const period = 24.0 - 21.0 * speed;
                    const hsv = toHsv(base);
                    for (&zones, 0..) |*z, i| z.* = fromHsv(@mod(t * 360.0 / period + @as(f32, @floatFromInt(i)) * 120.0, 360.0), @max(hsv.s, 0.85), 1.0);
                },
                .candle => {
                    const random = prng.random();
                    for (&candle, 0..) |*c, i| {
                        c.* += (random.float(f32) - 0.5) * (0.12 + 0.3 * speed);
                        c.* += (0.82 - c.*) * 0.08;
                        c.* = std.math.clamp(c.*, 0.45, 1.0);
                        zones[i] = scale(base, c.*);
                    }
                },
                .music => zones = music.render(config, engine.hub.features(.playback), base, t),
            }
            engine.write(zones, config.brightness);

            engine.mutex.lock();
            if (engine.version == version) {
                if (animated) {
                    engine.cond.timedWait(&engine.mutex, frame_ns) catch {};
                } else {
                    engine.cond.wait(&engine.mutex);
                }
            }
            engine.mutex.unlock();
        }
    }

    fn write(engine: *Engine, zones: [3]Rgb, brightness: u8) void {
        const gain = @as(f32, @floatFromInt(brightness)) / 255.0;
        const colours = [_][]const u8{ "red", "green", "blue" };
        for (zones, 0..) |zone, z| {
            const channels = [_]f32{ zone.r, zone.g, zone.b };
            for (channels, 0..) |value, c| {
                const index = z * 3 + c;
                const out: i16 = @intFromFloat(std.math.clamp(value * gain, 0, 255));
                if (engine.written[index] == out) continue;
                const fd = engine.fds[index] orelse blk: {
                    var path_buf: [64]u8 = undefined;
                    const path = std.fmt.bufPrint(&path_buf, "/sys/class/leds/plum:{s}:ring{d}/brightness", .{ colours[c], z + 1 }) catch continue;
                    const opened = std.posix.open(path, .{ .ACCMODE = .WRONLY }, 0) catch continue;
                    engine.fds[index] = opened;
                    break :blk opened;
                };
                var text_buf: [4]u8 = undefined;
                const text = std.fmt.bufPrint(&text_buf, "{d}", .{out}) catch continue;
                _ = std.posix.pwrite(fd, text, 0) catch {
                    std.posix.close(fd);
                    engine.fds[index] = null;
                    continue;
                };
                engine.written[index] = out;
            }
        }
    }
};

const black = Rgb{ .r = 0, .g = 0, .b = 0 };

fn scale(c: Rgb, v: f32) Rgb {
    return .{ .r = c.r * v, .g = c.g * v, .b = c.b * v };
}

const Hsv = struct { h: f32, s: f32, v: f32 };

fn toHsv(c: Rgb) Hsv {
    const r = c.r / 255.0;
    const g = c.g / 255.0;
    const b = c.b / 255.0;
    const max = @max(r, @max(g, b));
    const min = @min(r, @min(g, b));
    const d = max - min;
    var h: f32 = 0;
    if (d > 0) {
        if (max == r) h = 60.0 * @mod((g - b) / d, 6.0) else if (max == g) h = 60.0 * ((b - r) / d + 2.0) else h = 60.0 * ((r - g) / d + 4.0);
    }
    return .{ .h = h, .s = if (max > 0) d / max else 0, .v = max };
}

fn fromHsv(h: f32, s: f32, v: f32) Rgb {
    const c = v * s;
    const x = c * (1.0 - @abs(@mod(h / 60.0, 2.0) - 1.0));
    const m = v - c;
    const sector: u32 = @intFromFloat(@mod(h, 360.0) / 60.0);
    const rgb: [3]f32 = switch (sector) {
        0 => .{ c, x, 0 },
        1 => .{ x, c, 0 },
        2 => .{ 0, c, x },
        3 => .{ 0, x, c },
        4 => .{ x, 0, c },
        else => .{ c, 0, x },
    };
    return .{ .r = (rgb[0] + m) * 255.0, .g = (rgb[1] + m) * 255.0, .b = (rgb[2] + m) * 255.0 };
}

/// Perceptual curve so low levels fade smoothly instead of jumping.
fn curve(v: f32) f32 {
    const x = std.math.clamp(v, 0, 1);
    return x * x;
}

const MusicState = struct {
    env: f32 = 0,
    zone_env: [3]f32 = .{ 0, 0, 0 },
    flash: f32 = 0,
    hue_offset: f32 = 0,
    lead: usize = 0,
    last_seq: u64 = 0,

    fn follow(value: *f32, target: f32, decay: f32) void {
        value.* += (target - value.*) * (if (target > value.*) 0.65 else decay);
    }

    fn render(m: *MusicState, config: Config, f: audio.Features, base: Rgb, t: f32) [3]Rgb {
        const gain = 0.4 + @as(f32, @floatFromInt(config.sensitivity)) / 50.0;
        const decay = 0.04 + 0.26 * @as(f32, @floatFromInt(config.speed)) / 100.0;
        const fresh = f.seq != m.last_seq;
        m.last_seq = f.seq;
        const hsv = toHsv(base);
        const floor: f32 = 0.03;
        switch (config.algo) {
            .pulse => {
                follow(&m.env, std.math.clamp(f.level * gain, 0, 1), decay);
                const v = floor + (1 - floor) * curve(m.env);
                return .{ scale(base, v), scale(base, v), scale(base, v) };
            },
            .spectrum => {
                const parts = [3]f32{ f.bass, f.mid, f.treble };
                var out: [3]Rgb = undefined;
                for (0..3) |i| {
                    follow(&m.zone_env[i], std.math.clamp(parts[i] * gain, 0, 1), decay);
                    const hue = @mod(hsv.h + @as(f32, @floatFromInt(i)) * 35.0, 360.0);
                    out[i] = fromHsv(hue, @max(hsv.s, 0.6), floor + (1 - floor) * curve(m.zone_env[i]));
                }
                return out;
            },
            .beat => {
                if (fresh and f.beat) {
                    m.flash = 1;
                    m.hue_offset = @mod(m.hue_offset + 47.0, 360.0);
                    m.lead = (m.lead + 1) % 3;
                }
                m.flash *= 1.0 - decay * 0.6;
                follow(&m.env, std.math.clamp(f.level * gain, 0, 1), decay);
                const hue = @mod(hsv.h + m.hue_offset, 360.0);
                var out: [3]Rgb = undefined;
                for (0..3) |i| {
                    const lead_boost: f32 = if (i == m.lead) 1.0 else 0.4;
                    const v = floor + (1 - floor) * std.math.clamp(m.flash * lead_boost + 0.25 * curve(m.env), 0, 1);
                    out[i] = fromHsv(hue, @max(hsv.s, 0.7), v);
                }
                return out;
            },
            .flow => {
                follow(&m.env, std.math.clamp(f.level * gain, 0, 1), decay);
                const drift = t * (4.0 + 20.0 * @as(f32, @floatFromInt(config.speed)) / 100.0);
                var out: [3]Rgb = undefined;
                for (0..3) |i| {
                    const hue = @mod(hsv.h + f.centroid * 240.0 + drift + @as(f32, @floatFromInt(i)) * 25.0, 360.0);
                    out[i] = fromHsv(hue, @max(hsv.s, 0.75), floor + (1 - floor) * curve(m.env));
                }
                return out;
            },
        }
    }
};

fn load() ?Config {
    const file = std.fs.openFileAbsolute(core.config.lights_path, .{}) catch return null;
    defer file.close();
    var buffer: [1024]u8 = undefined;
    const count = file.readAll(&buffer) catch return null;
    var fba = std.heap.FixedBufferAllocator.init(buffer[count..]);
    return std.json.parseFromSliceLeaky(Config, fba.allocator(), buffer[0..count], .{ .ignore_unknown_fields = true }) catch null;
}

fn save(config: Config) void {
    var buffer: [512]u8 = undefined;
    const body = std.fmt.bufPrint(&buffer, "{f}", .{std.json.fmt(config, .{})}) catch return;
    var file = std.fs.createFileAbsolute(core.config.lights_path, .{ .truncate = true }) catch return;
    defer file.close();
    file.writeAll(body) catch {};
}

/// First start: keep whatever colour the ring shows.
fn fromHardware() Config {
    const read = struct {
        fn value(path: []const u8) u8 {
            const file = std.fs.openFileAbsolute(path, .{}) catch return 0;
            defer file.close();
            var buffer: [8]u8 = undefined;
            const count = file.read(&buffer) catch return 0;
            return std.fmt.parseInt(u8, std.mem.trim(u8, buffer[0..count], " \t\r\n"), 10) catch 0;
        }
    }.value;
    const r = read("/sys/class/leds/plum:red:ring1/brightness");
    const g = read("/sys/class/leds/plum:green:ring1/brightness");
    const b = read("/sys/class/leds/plum:blue:ring1/brightness");
    if (r == 0 and g == 0 and b == 0) return .{ .mode = .off };
    return .{ .mode = .static, .r = r, .g = g, .b = b, .brightness = 255 };
}

test "hsv round trip" {
    const c = fromHsv(200, 0.8, 0.9);
    const hsv = toHsv(c);
    try std.testing.expectApproxEqAbs(@as(f32, 200), hsv.h, 0.5);
    try std.testing.expectApproxEqAbs(@as(f32, 0.8), hsv.s, 0.01);
}
