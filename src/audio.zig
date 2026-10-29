//! Real-time audio analysis for the visualiser, the LED music modes and the
//! microphone meter, plus the master volume.
//!
//! Sources are captured with the stock `arecord`, only while someone needs
//! them (`Hub.acquire`/`release`):
//!   playback - TDM-B loopback of what the speaker plays (hw:0,0). Must be
//!              48 kHz: a capture at another rate reprograms mpll1 and
//!              detunes playback (see docs/bluetooth-audio.md).
//!   mic      - the raw PDM array (hw:0,1), 8 slots: mic0 = slot 0,
//!              mic1 = slot 2, exactly as /etc/asound.conf maps them. No
//!              Yandex VQE: the Quasar stack stays off.
//!
//! Each source publishes a compact binary frame (see `frame_len`) 30 times per
//! second; the live WebSocket forwards it as is and the light engine reads
//! `Features`.
const std = @import("std");
const core = @import("core.zig");

pub const Source = enum(u8) { playback = 0, mic = 1 };
pub const band_count = 48;
pub const wave_points = 128;
/// Frame layout (all u8 unless noted):
///  0 version (1)        1 source            2 flags (bit0 = beat)   3 band count
///  4 level, dBFS        5 peak, dBFS        6 bass   7 mid   8 treble (0..255, auto-gain)
///  9 mic0, dBFS        10 mic1, dBFS        11 level (0..255, auto-gain)
/// 12.. band_count band magnitudes (0..255, auto-gain)
///  .. wave_points waveform samples (i8, auto-gain)
/// dBFS bytes map -90 dB .. 0 dB linearly onto 0..255.
pub const frame_len = 12 + band_count + wave_points;

const rate = 48000;
const fft_n = 2048;
const hop = 1600; // 30 frames per second
const idle_stop_ms = 2000;
const fft_power_norm: f32 = 1.0 / ((fft_n / 4.0) * (fft_n / 4.0));

/// Normalised features for consumers inside the process (light engine).
pub const Features = struct { level: f32 = 0, bass: f32 = 0, mid: f32 = 0, treble: f32 = 0, centroid: f32 = 0, beat: bool = false, seq: u64 = 0 };

const Channel = struct {
    demand: u32 = 0,
    running: bool = false,
    seq: u64 = 0,
    frame: [frame_len]u8 = [_]u8{0} ** frame_len,
    features: Features = .{},
};

pub const Hub = struct {
    mutex: std.Thread.Mutex = .{},
    cond: std.Thread.Condition = .{},
    /// Incremented on every published frame of any source.
    seq: u64 = 0,
    channels: [2]Channel = .{ .{}, .{} },

    pub fn acquire(hub: *Hub, source: Source) void {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        const channel = &hub.channels[@intFromEnum(source)];
        channel.demand += 1;
        if (channel.running) return;
        channel.running = true;
        const thread = std.Thread.spawn(.{}, worker, .{ hub, source }) catch |err| {
            std.log.err("audio {t}: worker spawn failed: {t}", .{ source, err });
            channel.running = false;
            return;
        };
        thread.detach();
    }

    pub fn release(hub: *Hub, source: Source) void {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        const channel = &hub.channels[@intFromEnum(source)];
        channel.demand -|= 1;
    }

    /// Waits until a frame newer than `seen` exists or `timeout_ns` elapses.
    pub fn waitNewer(hub: *Hub, seen: u64, timeout_ns: u64) u64 {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        if (hub.seq == seen) hub.cond.timedWait(&hub.mutex, timeout_ns) catch {};
        return hub.seq;
    }

    /// Copies the latest frame of `source`; returns its sequence number (0 = none yet).
    pub fn copyFrame(hub: *Hub, source: Source, out: *[frame_len]u8) u64 {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        const channel = &hub.channels[@intFromEnum(source)];
        out.* = channel.frame;
        return channel.seq;
    }

    pub fn features(hub: *Hub, source: Source) Features {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        return hub.channels[@intFromEnum(source)].features;
    }

    fn publish(hub: *Hub, source: Source, frame: *const [frame_len]u8, f: Features) void {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        const channel = &hub.channels[@intFromEnum(source)];
        channel.frame = frame.*;
        channel.seq += 1;
        channel.features = f;
        channel.features.seq = channel.seq;
        hub.seq += 1;
        hub.cond.broadcast();
    }

    /// Called by a worker: stops it when nobody needs the source any more.
    fn shouldStop(hub: *Hub, source: Source, idle_since: *?i64) bool {
        hub.mutex.lock();
        defer hub.mutex.unlock();
        const channel = &hub.channels[@intFromEnum(source)];
        if (channel.demand > 0) {
            idle_since.* = null;
            return false;
        }
        const now = std.time.milliTimestamp();
        const since = idle_since.* orelse blk: {
            idle_since.* = now;
            break :blk now;
        };
        if (now - since < idle_stop_ms) return false;
        channel.running = false;
        return true;
    }
};

fn worker(hub: *Hub, source: Source) void {
    var analyser = Analyser.init(source);
    var idle_since: ?i64 = null;
    while (true) {
        capture(hub, source, &analyser, &idle_since) catch |err| {
            std.log.warn("audio {t}: capture failed: {t}", .{ source, err });
        };
        if (hub.shouldStop(source, &idle_since)) return;
        // arecord died (device busy, xrun): back off and retry while needed.
        var waited: u32 = 0;
        while (waited < 10) : (waited += 1) {
            std.Thread.sleep(100 * std.time.ns_per_ms);
            if (hub.shouldStop(source, &idle_since)) return;
        }
    }
}

fn capture(hub: *Hub, source: Source, analyser: *Analyser, idle_since: *?i64) !void {
    const argv: []const []const u8 = switch (source) {
        .playback => &.{ "arecord", "-q", "-D", "hw:0,0", "-f", "S16_LE", "-r", "48000", "-c", "2", "-t", "raw" },
        .mic => &.{ "arecord", "-q", "-D", "hw:0,1", "-f", "S16_LE", "-r", "48000", "-c", "8", "-t", "raw" },
    };
    var child = std.process.Child.init(argv, core.allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    try child.spawn();
    defer {
        _ = child.kill() catch {};
    }
    const channels: usize = if (source == .playback) 2 else 8;
    const frame_bytes = channels * 2;
    var buffer: [hop * 16]u8 = undefined;
    var filled: usize = 0;
    const want = hop * frame_bytes;
    const stdout = child.stdout.?;
    while (true) {
        const count = try stdout.read(buffer[filled..want]);
        if (count == 0) return error.EndOfStream;
        filled += count;
        if (filled < want) continue;
        filled = 0;
        const samples = std.mem.bytesAsSlice(i16, buffer[0..want]);
        var frame: [frame_len]u8 = undefined;
        const f = analyser.process(samples, channels, &frame);
        hub.publish(source, &frame, f);
        if (hub.shouldStop(source, idle_since)) return;
    }
}

fn dbfsByte(value: f32) u8 {
    const db = 20.0 * std.math.log10(@max(value, 1e-6));
    return @intFromFloat(std.math.clamp((db + 90.0) / 90.0 * 255.0, 0, 255));
}

fn unitByte(value: f32) u8 {
    return @intFromFloat(std.math.clamp(value, 0, 1) * 255.0);
}

/// FFT, log bands, auto-gain and beat detection for one source.
const Analyser = struct {
    source: Source,
    history: [fft_n]f32 = [_]f32{0} ** fft_n,
    window: [fft_n]f32 = undefined,
    re: [fft_n]f32 = undefined,
    im: [fft_n]f32 = undefined,
    cos_table: [fft_n / 2]f32 = undefined,
    sin_table: [fft_n / 2]f32 = undefined,
    band_lo: [band_count]usize = undefined,
    band_hi: [band_count]usize = undefined,
    band_tilt: [band_count]f32 = undefined,
    /// Auto-gain references (decaying maxima), in dB / linear.
    band_ref_db: f32 = -40,
    level_ref_db: f32 = -40,
    wave_ref: f32 = 0.05,
    /// DC removal for the PDM mics.
    dc: [2]f32 = .{ 0, 0 },
    bass_history: [30]f32 = [_]f32{0} ** 30,
    bass_index: usize = 0,
    frames_since_beat: u32 = 100,

    fn init(source: Source) Analyser {
        var a = Analyser{ .source = source };
        for (&a.window, 0..) |*w, i| w.* = 0.5 - 0.5 * @cos(2.0 * std.math.pi * @as(f32, @floatFromInt(i)) / @as(f32, fft_n - 1));
        for (0..fft_n / 2) |i| {
            const angle = -2.0 * std.math.pi * @as(f32, @floatFromInt(i)) / @as(f32, fft_n);
            a.cos_table[i] = @cos(angle);
            a.sin_table[i] = @sin(angle);
        }
        // Log-spaced bands 40 Hz .. 16 kHz; every band gets at least one bin.
        const bin_hz: f32 = @as(f32, rate) / @as(f32, fft_n);
        const lo_hz: f32 = 40.0;
        const hi_hz: f32 = 16000.0;
        var previous_hi: usize = 1;
        for (0..band_count) |b| {
            const f0 = lo_hz * std.math.pow(f32, hi_hz / lo_hz, @as(f32, @floatFromInt(b)) / band_count);
            const f1 = lo_hz * std.math.pow(f32, hi_hz / lo_hz, @as(f32, @floatFromInt(b + 1)) / band_count);
            var lo: usize = @intFromFloat(@floor(f0 / bin_hz));
            var hi: usize = @intFromFloat(@ceil(f1 / bin_hz));
            lo = @max(lo, previous_hi -| 1);
            lo = @max(lo, 1);
            if (hi <= lo) hi = lo + 1;
            a.band_lo[b] = lo;
            a.band_hi[b] = @min(hi, fft_n / 2);
            previous_hi = hi;
            // +3 dB/octave so music looks balanced instead of bass-heavy.
            const centre = @sqrt(f0 * f1);
            a.band_tilt[b] = 3.0 * std.math.log2(centre / 1000.0);
        }
        return a;
    }

    fn fft(a: *Analyser) void {
        const n = fft_n;
        // Bit-reversal permutation.
        var j: usize = 0;
        for (1..n) |i| {
            var bit: usize = n >> 1;
            while (j & bit != 0) : (bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                std.mem.swap(f32, &a.re[i], &a.re[j]);
                std.mem.swap(f32, &a.im[i], &a.im[j]);
            }
        }
        var len: usize = 2;
        while (len <= n) : (len <<= 1) {
            const half = len / 2;
            const step = n / len;
            var start: usize = 0;
            while (start < n) : (start += len) {
                for (0..half) |k| {
                    const wr = a.cos_table[k * step];
                    const wi = a.sin_table[k * step];
                    const xr = a.re[start + k + half] * wr - a.im[start + k + half] * wi;
                    const xi = a.re[start + k + half] * wi + a.im[start + k + half] * wr;
                    a.re[start + k + half] = a.re[start + k] - xr;
                    a.im[start + k + half] = a.im[start + k] - xi;
                    a.re[start + k] += xr;
                    a.im[start + k] += xi;
                }
            }
        }
    }

    /// Consumes one hop of interleaved samples and renders a frame.
    fn process(a: *Analyser, samples: []align(1) const i16, channels: usize, frame: *[frame_len]u8) Features {
        const frames = samples.len / channels;
        // Shift history and append the new mono samples.
        std.mem.copyForwards(f32, a.history[0 .. fft_n - frames], a.history[frames..]);
        var sum_sq: f32 = 0;
        var peak: f32 = 0;
        var mic_sq = [2]f32{ 0, 0 };
        for (0..frames) |i| {
            const base = i * channels;
            var mono: f32 = undefined;
            if (a.source == .playback) {
                mono = (@as(f32, @floatFromInt(samples[base])) + @as(f32, @floatFromInt(samples[base + 1]))) / 65536.0;
            } else {
                var m: [2]f32 = undefined;
                for (0..2) |c| {
                    const x = @as(f32, @floatFromInt(samples[base + c * 2])) / 32768.0;
                    a.dc[c] += (x - a.dc[c]) * 0.001;
                    m[c] = x - a.dc[c];
                    mic_sq[c] += m[c] * m[c];
                }
                mono = (m[0] + m[1]) * 0.5;
            }
            a.history[fft_n - frames + i] = mono;
            sum_sq += mono * mono;
            peak = @max(peak, @abs(mono));
        }
        const rms = @sqrt(sum_sq / @as(f32, @floatFromInt(frames)));

        for (0..fft_n) |i| {
            a.re[i] = a.history[i] * a.window[i];
            a.im[i] = 0;
        }
        a.fft();

        // Band magnitudes in dB, then auto-gain against a decaying maximum.
        var band_db: [band_count]f32 = undefined;
        var frame_max_db: f32 = -200;
        var weighted: f32 = 0;
        var total: f32 = 0;
        for (0..band_count) |b| {
            var power: f32 = 0;
            for (a.band_lo[b]..a.band_hi[b]) |k| power = @max(power, a.re[k] * a.re[k] + a.im[k] * a.im[k]);
            // Scale so a full-scale sine reads 0 dB (Hann gain 0.5, N/2 bins).
            const db = 10.0 * std.math.log10(power * fft_power_norm + 1e-14) + a.band_tilt[b];
            band_db[b] = db;
            frame_max_db = @max(frame_max_db, db);
            const lin = @sqrt(power);
            weighted += lin * @as(f32, @floatFromInt(b));
            total += lin;
        }
        // Reference follows peaks instantly and decays ~3 dB/s; never below a
        // floor, so silence stays dark instead of amplifying noise.
        const floor_db: f32 = if (a.source == .mic) -55 else -45;
        a.band_ref_db = @max(@max(a.band_ref_db - 0.1, frame_max_db), floor_db);
        const range_db: f32 = 50;
        var bands: [band_count]f32 = undefined;
        for (0..band_count) |b| bands[b] = std.math.clamp((band_db[b] - (a.band_ref_db - range_db)) / range_db, 0, 1);

        const level_db = 20.0 * std.math.log10(@max(rms, 1e-6));
        const level_floor_db: f32 = if (a.source == .mic) -60 else -45;
        a.level_ref_db = @max(@max(a.level_ref_db - 0.1, level_db), level_floor_db);
        const level_norm = std.math.clamp((level_db - (a.level_ref_db - 36.0)) / 36.0, 0, 1);

        const avg = struct {
            fn of(values: []const f32) f32 {
                var s: f32 = 0;
                for (values) |v| s += v;
                return s / @as(f32, @floatFromInt(values.len));
            }
        }.of;
        // 40-250 Hz, 250 Hz-4 kHz, 4-16 kHz with 48 log bands over 40 Hz-16 kHz.
        const bass = avg(bands[0..15]);
        const mid = avg(bands[15..37]);
        const treble = avg(bands[37..]);

        // Beat: bass energy well above its one-second average.
        var bass_energy: f32 = 0;
        for (0..10) |b| bass_energy += std.math.pow(f32, 10.0, band_db[b] / 10.0);
        var history_avg: f32 = 0;
        for (a.bass_history) |e| history_avg += e;
        history_avg /= @as(f32, a.bass_history.len);
        a.bass_history[a.bass_index] = bass_energy;
        a.bass_index = (a.bass_index + 1) % a.bass_history.len;
        a.frames_since_beat +|= 1;
        const beat = level_norm > 0.15 and bass_energy > history_avg * 1.6 and a.frames_since_beat >= 6;
        if (beat) a.frames_since_beat = 0;

        a.wave_ref = @max(a.wave_ref * 0.995, @max(peak, 0.01));
        const centroid = if (total > 0) weighted / total / @as(f32, band_count - 1) else 0;

        frame[0] = 1;
        frame[1] = @intFromEnum(a.source);
        frame[2] = if (beat) 1 else 0;
        frame[3] = band_count;
        frame[4] = dbfsByte(rms);
        frame[5] = dbfsByte(peak);
        frame[6] = unitByte(bass);
        frame[7] = unitByte(mid);
        frame[8] = unitByte(treble);
        frame[9] = dbfsByte(@sqrt(mic_sq[0] / @as(f32, @floatFromInt(frames))));
        frame[10] = dbfsByte(@sqrt(mic_sq[1] / @as(f32, @floatFromInt(frames))));
        frame[11] = unitByte(level_norm);
        for (0..band_count) |b| frame[12 + b] = unitByte(bands[b]);
        const stride = fft_n / wave_points;
        for (0..wave_points) |i| {
            const v = std.math.clamp(a.history[i * stride] / a.wave_ref, -1, 1);
            frame[12 + band_count + i] = @bitCast(@as(i8, @intFromFloat(v * 127.0)));
        }
        return .{ .level = level_norm, .bass = bass, .mid = mid, .treble = treble, .centroid = centroid, .beat = beat };
    }
};

// ---------- master volume (softvol "Master Playback Volume", 0..255) ----------

const volume_control = "name=Master Playback Volume";

/// Reads the master volume as 0..100.
pub fn readVolume() ?u8 {
    const result = std.process.Child.run(.{ .allocator = core.allocator, .argv = &.{ "amixer", "-c", "0", "cget", volume_control }, .max_output_bytes = 16 * 1024 }) catch return null;
    defer core.allocator.free(result.stdout);
    defer core.allocator.free(result.stderr);
    const marker = ": values=";
    const at = std.mem.indexOf(u8, result.stdout, marker) orelse return null;
    const rest = result.stdout[at + marker.len ..];
    const end = std.mem.indexOfAny(u8, rest, ",\n") orelse rest.len;
    const raw = std.fmt.parseInt(u32, std.mem.trim(u8, rest[0..end], " \r"), 10) catch return null;
    return @intCast(@min(100, (raw * 100 + 127) / 255));
}

pub fn setVolume(percent: u8) !void {
    const raw: u32 = (@as(u32, @min(percent, 100)) * 255 + 50) / 100;
    var buffer: [16]u8 = undefined;
    const value = try std.fmt.bufPrint(&buffer, "{d},{d}", .{ raw, raw });
    const result = try std.process.Child.run(.{ .allocator = core.allocator, .argv = &.{ "amixer", "-q", "-c", "0", "cset", volume_control, value }, .max_output_bytes = 16 * 1024 });
    defer core.allocator.free(result.stdout);
    defer core.allocator.free(result.stderr);
    switch (result.term) {
        .Exited => |code| if (code != 0) return error.AmixerFailed,
        else => return error.AmixerFailed,
    }
}

test "analyser detects a 1 kHz tone in the right band" {
    var a = Analyser.init(.playback);
    var samples: [hop * 2]i16 = undefined;
    var frame: [frame_len]u8 = undefined;
    var f: Features = .{};
    var n: usize = 0;
    for (0..4) |_| {
        for (0..hop) |i| {
            const t = @as(f32, @floatFromInt(n + i)) / rate;
            const v: i16 = @intFromFloat(@sin(2.0 * std.math.pi * 1000.0 * t) * 16000.0);
            samples[i * 2] = v;
            samples[i * 2 + 1] = v;
        }
        n += hop;
        f = a.process(&samples, 2, &frame);
    }
    // Strongest band must contain 1 kHz.
    var best: usize = 0;
    for (0..band_count) |b| {
        if (frame[12 + b] > frame[12 + best]) best = b;
    }
    const bin_hz: f32 = @as(f32, rate) / fft_n;
    try std.testing.expect(@as(f32, @floatFromInt(a.band_lo[best])) * bin_hz <= 1050);
    try std.testing.expect(@as(f32, @floatFromInt(a.band_hi[best])) * bin_hz >= 950);
    try std.testing.expect(f.level > 0.5);
    try std.testing.expect(frame[4] > 200); // ~ -9 dBFS
}
