//! Screens and widgets shared by every signed-in device: layout.json in
//! $PANEL_DATA_DIR, {"revision": N, "layout": {...}}. The layout itself is the
//! client's JSON (web/src/ui/panels/store.ts), checked to be an object and
//! stored as is. /dashboard reports the revision so other devices notice
//! changes without polling a second endpoint. Callers hold ctx.mutex.
const std = @import("std");
const core = @import("core.zig");

const A = core.allocator;
pub const max_size = 96 * 1024;

pub const Store = struct {
    /// Serialized layout object, or null until the first device uploads one.
    json: ?[]u8 = null,
    revision: u32 = 0,
};

pub fn load(ctx: *core.Context) void {
    const file = std.fs.openFileAbsolute(core.config.layout_path, .{}) catch return;
    defer file.close();
    const data = file.readToEndAlloc(A, 2 * max_size) catch return;
    defer A.free(data);
    var arena = std.heap.ArenaAllocator.init(A);
    defer arena.deinit();
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), data, .{}) catch {
        std.log.err("layout.json is not valid JSON, ignoring it", .{});
        return;
    };
    if (root != .object) return;
    const layout = root.object.get("layout") orelse return;
    if (layout != .object) return;
    const revision = root.object.get("revision") orelse return;
    if (revision != .integer or revision.integer < 0) return;
    ctx.layout.json = std.fmt.allocPrint(A, "{f}", .{std.json.fmt(layout, .{})}) catch return;
    ctx.layout.revision = @intCast(@min(revision.integer, std.math.maxInt(u32)));
}

/// Replaces the shared layout with `body` = {"layout": {...}}; returns the new revision.
pub fn set(ctx: *core.Context, arena: std.mem.Allocator, body: []const u8) !u32 {
    const root = std.json.parseFromSliceLeaky(std.json.Value, arena, body, .{}) catch return error.InvalidLayout;
    if (root != .object) return error.InvalidLayout;
    const layout = root.object.get("layout") orelse return error.InvalidLayout;
    if (layout != .object) return error.InvalidLayout;
    const json = try std.fmt.allocPrint(A, "{f}", .{std.json.fmt(layout, .{})});
    errdefer A.free(json);
    if (json.len > max_size) return error.LayoutTooLarge;
    const revision = ctx.layout.revision +% 1;
    const file_body = try std.fmt.allocPrint(arena, "{{\"revision\":{d},\"layout\":{s}}}", .{ revision, json });
    try core.writeFileAtomic(core.config.layout_path, file_body);
    if (ctx.layout.json) |old| A.free(old);
    ctx.layout.json = json;
    ctx.layout.revision = revision;
    return revision;
}

/// GET body: {"ok":true,"revision":N,"layout":{...}|null}.
pub fn response(ctx: *core.Context, arena: std.mem.Allocator) ![]const u8 {
    return std.fmt.allocPrint(arena, "{{\"ok\":true,\"revision\":{d},\"layout\":{s}}}", .{ ctx.layout.revision, ctx.layout.json orelse "null" });
}

test "a layout round-trips through set, the file and load" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try tmp.dir.realpathAlloc(A, ".");
    core.config = undefined;
    core.config.layout_path = try std.fs.path.join(A, &.{ dir, "layout.json" });
    var arena = std.heap.ArenaAllocator.init(A);
    defer arena.deinit();
    var ctx = core.Context{};
    try std.testing.expectError(error.InvalidLayout, set(&ctx, arena.allocator(), "{\"layout\":[1,2]}"));
    try std.testing.expectError(error.InvalidLayout, set(&ctx, arena.allocator(), "not json"));
    const body = "{\"layout\":{\"version\":3,\"panels\":[{\"id\":\"home\",\"title\":\"Главная\",\"widgets\":[]}]}}";
    try std.testing.expectEqual(@as(u32, 1), try set(&ctx, arena.allocator(), body));
    try std.testing.expectEqual(@as(u32, 2), try set(&ctx, arena.allocator(), body));
    var again = core.Context{};
    load(&again);
    try std.testing.expectEqual(@as(u32, 2), again.layout.revision);
    try std.testing.expectEqualStrings(ctx.layout.json.?, again.layout.json.?);
    // Key order is kept: the client compares layouts by their JSON text.
    try std.testing.expect(std.mem.startsWith(u8, again.layout.json.?, "{\"version\":3,\"panels\""));
}
