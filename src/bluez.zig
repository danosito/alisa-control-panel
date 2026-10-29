//! BlueZ through D-Bus, using the stock `dbus-send`.
//!
//! State: one ObjectManager.GetManagedObjects call (~50 ms) yields the adapter,
//! every device, the AVRCP media player and the A2DP transport. The previous
//! implementation ran a dozen `bluetoothctl` processes per refresh; each one
//! registered an agent and an advertisement monitor and flooded syslog.
//! Actions: Device1.Connect/Disconnect, Adapter1.RemoveDevice, adapter
//! properties and MediaPlayer1.Play/Pause/Next/Previous.
const std = @import("std");
const core = @import("core.zig");

pub const adapter_path = "/org/bluez/hci0";

/// Everything BlueZ reported in one call. Every string slice points into `raw`.
pub const Snapshot = struct {
    raw: []u8 = &.{},
    adapter: core.BluetoothState = .{ .name = "", .pairing = false, .discoverable = false },
    devices: []core.BluetoothDevice = &.{},
    media: core.MediaState = .{},
    /// Object path of the selected MediaPlayer1 ("" if none) for controls.
    player_path: []const u8 = "",

    pub fn deinit(self: *Snapshot) void {
        if (self.devices.len > 0) core.allocator.free(self.devices);
        if (self.raw.len > 0) core.allocator.free(self.raw);
        self.* = .{};
    }
};

// dbus-send --print-reply indents three spaces per nesting level. These are the
// columns of the object path keys, interface names and property names of the
// ObjectManager reply (a{oa{sa{sv}}}). Track metadata is nested deeper.
const object_indent = 9;
const interface_indent = 15;
const property_indent = 21;

const Value = union(enum) { text: []const u8, number: u64, flag: bool, none };

fn quoted(line: []const u8) ?[]const u8 {
    const first = std.mem.indexOfScalar(u8, line, '"') orelse return null;
    const last = std.mem.lastIndexOfScalar(u8, line, '"') orelse return null;
    if (last <= first) return null;
    return line[first + 1 .. last];
}

fn variantValue(line: []const u8) Value {
    const rest = std.mem.trimLeft(u8, line["variant".len..], " \t");
    if (std.mem.startsWith(u8, rest, "string ") or std.mem.startsWith(u8, rest, "object path ")) return .{ .text = quoted(rest) orelse "" };
    if (std.mem.startsWith(u8, rest, "boolean ")) return .{ .flag = std.mem.eql(u8, std.mem.trim(u8, rest[8..], " \r"), "true") };
    inline for (.{ "uint32 ", "uint16 ", "uint64 ", "byte ", "int32 ", "int16 " }) |prefix| {
        if (std.mem.startsWith(u8, rest, prefix)) return .{ .number = std.fmt.parseInt(u64, std.mem.trim(u8, rest[prefix.len..], " \r"), 10) catch 0 };
    }
    return .none;
}

const Device = struct { path: []const u8, address: []const u8 = "", name: []const u8 = "", alias: []const u8 = "", icon: []const u8 = "", paired: bool = false, connected: bool = false, trusted: bool = false };
const Player = struct { path: []const u8, device: []const u8 = "", status: []const u8 = "stopped", position: u32 = 0, title: []const u8 = "", artist: []const u8 = "", album: []const u8 = "", duration: u32 = 0 };
const Transport = struct { device: []const u8 = "", state: []const u8 = "" };

const Interface = enum { other, adapter, device, player, transport };

fn interfaceOf(name: []const u8) Interface {
    if (std.mem.eql(u8, name, "org.bluez.Adapter1")) return .adapter;
    if (std.mem.eql(u8, name, "org.bluez.Device1")) return .device;
    if (std.mem.eql(u8, name, "org.bluez.MediaPlayer1")) return .player;
    if (std.mem.eql(u8, name, "org.bluez.MediaTransport1")) return .transport;
    return .other;
}

fn text(value: Value) []const u8 {
    return switch (value) { .text => |t| t, else => "" };
}
fn flag(value: Value) bool {
    return switch (value) { .flag => |f| f, else => false };
}
fn number(value: Value) u32 {
    return switch (value) { .number => |n| @intCast(@min(n, std.math.maxInt(u32))), else => 0 };
}

/// Parses GetManagedObjects output. Takes ownership of `raw`.
pub fn parse(raw: []u8) !Snapshot {
    var snapshot = Snapshot{ .raw = raw };
    errdefer snapshot.deinit();
    var devices = std.ArrayList(Device).empty;
    defer devices.deinit(core.allocator);
    var players = std.ArrayList(Player).empty;
    defer players.deinit(core.allocator);
    var transports = std.ArrayList(Transport).empty;
    defer transports.deinit(core.allocator);

    var path: []const u8 = "";
    var interface: Interface = .other;
    var property: []const u8 = "";
    var track_key: []const u8 = "";
    var lines = std.mem.splitScalar(u8, raw, '\n');
    while (lines.next()) |line| {
        const indent = line.len - std.mem.trimLeft(u8, line, " ").len;
        const t = std.mem.trim(u8, line, " \r");
        if (indent == object_indent and std.mem.startsWith(u8, t, "object path \"")) {
            path = quoted(t) orelse "";
            interface = .other;
            continue;
        }
        if (indent == interface_indent and std.mem.startsWith(u8, t, "string \"")) {
            interface = interfaceOf(quoted(t) orelse "");
            switch (interface) {
                .device => try devices.append(core.allocator, .{ .path = path }),
                .player => try players.append(core.allocator, .{ .path = path }),
                .transport => try transports.append(core.allocator, .{}),
                else => {},
            }
            continue;
        }
        if (indent == property_indent and std.mem.startsWith(u8, t, "string \"")) {
            property = quoted(t) orelse "";
            continue;
        }
        const is_variant = std.mem.startsWith(u8, t, "variant");
        if (indent == property_indent and is_variant) {
            const value = variantValue(t);
            const eql = std.mem.eql;
            switch (interface) {
                .adapter => {
                    if (eql(u8, property, "Alias")) snapshot.adapter.name = text(value);
                    if (eql(u8, property, "Pairable")) snapshot.adapter.pairing = flag(value);
                    if (eql(u8, property, "Discoverable")) snapshot.adapter.discoverable = flag(value);
                },
                .device => {
                    const d = &devices.items[devices.items.len - 1];
                    if (eql(u8, property, "Address")) d.address = text(value);
                    if (eql(u8, property, "Name")) d.name = text(value);
                    if (eql(u8, property, "Alias")) d.alias = text(value);
                    if (eql(u8, property, "Icon")) d.icon = text(value);
                    if (eql(u8, property, "Paired")) d.paired = flag(value);
                    if (eql(u8, property, "Connected")) d.connected = flag(value);
                    if (eql(u8, property, "Trusted")) d.trusted = flag(value);
                },
                .player => {
                    const p = &players.items[players.items.len - 1];
                    if (eql(u8, property, "Device")) p.device = text(value);
                    if (eql(u8, property, "Status")) p.status = text(value);
                    if (eql(u8, property, "Position")) p.position = number(value);
                },
                .transport => {
                    const tr = &transports.items[transports.items.len - 1];
                    if (eql(u8, property, "Device")) tr.device = text(value);
                    if (eql(u8, property, "State")) tr.state = text(value);
                },
                .other => {},
            }
            continue;
        }
        // MediaPlayer1.Track is a{sv}: its keys and values sit deeper.
        if (indent > property_indent and interface == .player and std.mem.eql(u8, property, "Track")) {
            if (std.mem.startsWith(u8, t, "string \"")) {
                track_key = quoted(t) orelse "";
            } else if (is_variant) {
                const value = variantValue(t);
                const p = &players.items[players.items.len - 1];
                if (std.mem.eql(u8, track_key, "Title")) p.title = text(value);
                if (std.mem.eql(u8, track_key, "Artist")) p.artist = text(value);
                if (std.mem.eql(u8, track_key, "Album")) p.album = text(value);
                if (std.mem.eql(u8, track_key, "Duration")) p.duration = number(value);
            }
        }
    }

    // Paired or currently connected devices are the ones the UI manages.
    var list = std.ArrayList(core.BluetoothDevice).empty;
    errdefer list.deinit(core.allocator);
    for (devices.items) |d| {
        if (!d.paired and !d.connected) continue;
        try list.append(core.allocator, .{ .address = d.address, .name = if (d.alias.len > 0) d.alias else d.name, .paired = d.paired, .connected = d.connected, .trusted = d.trusted, .icon = d.icon });
    }
    snapshot.devices = try list.toOwnedSlice(core.allocator);

    // Prefer the player that is playing, then one on a connected device.
    var chosen: ?Player = null;
    for (players.items) |p| {
        if (std.mem.eql(u8, p.status, "playing")) {
            chosen = p;
            break;
        }
    }
    if (chosen == null) {
        outer: for (players.items) |p| {
            for (devices.items) |d| {
                if (d.connected and std.mem.eql(u8, d.path, p.device)) {
                    chosen = p;
                    break :outer;
                }
            }
        }
    }
    if (chosen) |p| {
        snapshot.player_path = p.path;
        snapshot.media = .{ .available = true, .status = p.status, .title = p.title, .artist = p.artist, .album = p.album, .duration_ms = p.duration, .position_ms = p.position };
        for (devices.items) |d| {
            if (!std.mem.eql(u8, d.path, p.device)) continue;
            snapshot.media.device = if (d.alias.len > 0) d.alias else d.name;
            snapshot.media.address = d.address;
        }
        for (transports.items) |tr| {
            if (std.mem.eql(u8, tr.device, p.device) and std.mem.eql(u8, tr.state, "active")) snapshot.media.streaming = true;
        }
    } else {
        // Sources without AVRCP metadata still stream: show where audio comes from.
        for (transports.items) |tr| {
            if (!std.mem.eql(u8, tr.state, "active")) continue;
            for (devices.items) |d| {
                if (!std.mem.eql(u8, d.path, tr.device)) continue;
                snapshot.media.device = if (d.alias.len > 0) d.alias else d.name;
                snapshot.media.address = d.address;
                snapshot.media.streaming = true;
            }
        }
    }
    return snapshot;
}

fn run(argv: []const []const u8, max_output: usize) !std.process.Child.RunResult {
    return std.process.Child.run(.{ .allocator = core.allocator, .argv = argv, .max_output_bytes = max_output });
}

/// Reads the whole BlueZ object tree.
pub fn fetch() !Snapshot {
    const result = try run(&.{ "dbus-send", "--system", "--print-reply", "--dest=org.bluez", "/", "org.freedesktop.DBus.ObjectManager.GetManagedObjects" }, 1024 * 1024);
    core.allocator.free(result.stderr);
    errdefer core.allocator.free(result.stdout);
    switch (result.term) {
        .Exited => |code| if (code != 0) return error.DbusFailed,
        else => return error.DbusFailed,
    }
    return parse(result.stdout);
}

/// Calls a BlueZ method; fails when dbus-send reports an error.
fn call(path: []const u8, method: []const u8, args: []const []const u8, timeout_ms: u32) !void {
    var timeout_buf: [32]u8 = undefined;
    const timeout = try std.fmt.bufPrint(&timeout_buf, "--reply-timeout={d}", .{timeout_ms});
    var argv: [12][]const u8 = undefined;
    const fixed = [_][]const u8{ "dbus-send", "--system", "--print-reply", timeout, "--dest=org.bluez", path, method };
    @memcpy(argv[0..fixed.len], &fixed);
    for (args, 0..) |arg, i| argv[fixed.len + i] = arg;
    const result = try run(argv[0 .. fixed.len + args.len], 64 * 1024);
    defer core.allocator.free(result.stdout);
    defer core.allocator.free(result.stderr);
    switch (result.term) {
        .Exited => |code| if (code != 0) {
            std.log.warn("bluez {s} {s} failed: {s}", .{ path, method, std.mem.trim(u8, result.stderr, " \r\n") });
            return error.BluezFailed;
        },
        else => return error.BluezFailed,
    }
}

/// "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF" for "AA:BB:CC:DD:EE:FF".
pub fn devicePath(buffer: *[48]u8, address: []const u8) []const u8 {
    const prefix = adapter_path ++ "/dev_";
    @memcpy(buffer[0..prefix.len], prefix);
    for (address, 0..) |char, i| buffer[prefix.len + i] = if (char == ':') '_' else std.ascii.toUpper(char);
    return buffer[0 .. prefix.len + address.len];
}

fn setProperty(path: []const u8, interface: []const u8, name: []const u8, value: []const u8) !void {
    var iface_buf: [64]u8 = undefined;
    var name_buf: [64]u8 = undefined;
    const iface_arg = try std.fmt.bufPrint(&iface_buf, "string:{s}", .{interface});
    const name_arg = try std.fmt.bufPrint(&name_buf, "string:{s}", .{name});
    try call(path, "org.freedesktop.DBus.Properties.Set", &.{ iface_arg, name_arg, value }, 5000);
}

pub const DeviceAction = enum { connect, disconnect, remove };

/// `address` must already be validated as AA:BB:CC:DD:EE:FF.
pub fn deviceAction(action: DeviceAction, address: []const u8) !void {
    var buffer: [48]u8 = undefined;
    const path = devicePath(&buffer, address);
    switch (action) {
        .connect => {
            // Trusted devices reconnect without asking the agent again.
            setProperty(path, "org.bluez.Device1", "Trusted", "variant:boolean:true") catch {};
            try call(path, "org.bluez.Device1.Connect", &.{}, 25000);
        },
        .disconnect => try call(path, "org.bluez.Device1.Disconnect", &.{}, 10000),
        .remove => {
            var arg_buf: [64]u8 = undefined;
            const arg = try std.fmt.bufPrint(&arg_buf, "objpath:{s}", .{path});
            try call(adapter_path, "org.bluez.Adapter1.RemoveDevice", &.{arg}, 10000);
        },
    }
}

/// Pairing window: discoverable + pairable. The stock just-works agent (S54)
/// accepts the pairing and trusts the device.
pub fn setPairing(enabled: bool) !void {
    const value = if (enabled) "variant:boolean:true" else "variant:boolean:false";
    try setProperty(adapter_path, "org.bluez.Adapter1", "Pairable", value);
    try setProperty(adapter_path, "org.bluez.Adapter1", "Discoverable", value);
}

pub const MediaAction = enum { play, pause, next, previous, stop };

pub fn mediaAction(player_path: []const u8, action: MediaAction) !void {
    const method = switch (action) {
        .play => "org.bluez.MediaPlayer1.Play",
        .pause => "org.bluez.MediaPlayer1.Pause",
        .next => "org.bluez.MediaPlayer1.Next",
        .previous => "org.bluez.MediaPlayer1.Previous",
        .stop => "org.bluez.MediaPlayer1.Stop",
    };
    try call(player_path, method, &.{}, 5000);
}

/// Fetches BlueZ state without holding the context lock, swaps it in and
/// bumps ctx.media_seq when the media state changed meaningfully.
pub fn refresh(ctx: *core.Context) void {
    var fresh = fetch() catch |err| {
        std.log.warn("bluez refresh failed: {t}", .{err});
        return;
    };
    const now = std.time.milliTimestamp();
    ctx.mutex.lock();
    var old = ctx.bluez;
    const changed = mediaChanged(old.media, fresh.media, now - ctx.bluez_fetched_ms);
    ctx.bluez = fresh;
    ctx.bluez_fetched_ms = now;
    ctx.mutex.unlock();
    if (changed) _ = ctx.media_seq.fetchAdd(1, .acq_rel);
    old.deinit();
    fresh = .{};
}

/// True when the change matters to clients: track/status/device changed, or
/// the position jumped (seek) instead of advancing with the clock.
pub fn mediaChanged(old: core.MediaState, new: core.MediaState, elapsed_ms: i64) bool {
    const eql = std.mem.eql;
    if (old.available != new.available or old.streaming != new.streaming or old.duration_ms != new.duration_ms) return true;
    if (!eql(u8, old.status, new.status) or !eql(u8, old.title, new.title) or !eql(u8, old.artist, new.artist) or !eql(u8, old.album, new.album) or !eql(u8, old.address, new.address)) return true;
    const expected: i64 = @as(i64, old.position_ms) + (if (eql(u8, old.status, "playing")) elapsed_ms else 0);
    return @abs(expected - @as(i64, new.position_ms)) > 1500;
}

test "parse captured GetManagedObjects output" {
    const fixture = @embedFile("testdata/bluez-objects.txt");
    const raw = try core.allocator.dupe(u8, fixture);
    var snapshot = try parse(raw);
    defer snapshot.deinit();
    try std.testing.expectEqualStrings("Station", snapshot.adapter.name);
    try std.testing.expectEqual(@as(usize, 3), snapshot.devices.len);
    try std.testing.expectEqualStrings("Desktop PC", snapshot.devices[0].name);
    try std.testing.expect(snapshot.devices[0].connected);
    try std.testing.expect(snapshot.devices[0].trusted);
    try std.testing.expectEqualStrings("computer", snapshot.devices[0].icon);
    try std.testing.expect(snapshot.media.available);
    try std.testing.expectEqualStrings("Power", snapshot.media.title);
    try std.testing.expectEqualStrings("Kanye West", snapshot.media.artist);
    try std.testing.expectEqual(@as(u32, 301603), snapshot.media.duration_ms);
    try std.testing.expectEqualStrings("Desktop PC", snapshot.media.device);
    try std.testing.expect(snapshot.media.streaming);
    try std.testing.expectEqualStrings("/org/bluez/hci0/dev_00_11_22_33_44_01/player0", snapshot.player_path);
}

test "device path" {
    var buffer: [48]u8 = undefined;
    try std.testing.expectEqualStrings("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_0F", devicePath(&buffer, "aa:bb:cc:dd:ee:0f"));
}
