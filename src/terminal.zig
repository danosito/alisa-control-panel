//! PTY sessions for the web terminal. Every WebSocket owns exactly one
//! Session: input, output and lifetime are never shared between sockets.
const std = @import("std");

extern fn forkpty(amaster: *c_int, name: ?[*]u8, termp: ?*anyopaque, winp: ?*anyopaque) c_int;
extern fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;
extern fn execl(path: [*:0]const u8, arg0: [*:0]const u8, ...) c_int;
extern fn ioctl(fd: c_int, request: c_ulong, ...) c_int;
extern fn chdir(path: [*:0]const u8) c_int;

const TIOCSWINSZ: c_ulong = 0x5414;
const WinSize = extern struct { rows: u16, cols: u16, xpixel: u16, ypixel: u16 };

pub const Shell = enum {
    bash,
    sh,

    pub fn parse(value: []const u8) Shell {
        return if (std.mem.eql(u8, value, "sh")) .sh else .bash;
    }
};

pub const Session = struct {
    fd: std.posix.fd_t,
    pid: std.posix.pid_t,
    /// Set by the WebSocket reader when the socket goes away; the output pump
    /// observes it within one poll interval and exits before the fd is closed.
    stopping: std.atomic.Value(bool) = .init(false),
    closed: std.atomic.Value(bool) = .init(false),

    pub fn spawn(shell: Shell, cols: u16, rows: u16) !Session {
        var master: c_int = -1;
        var size = WinSize{ .rows = clampDim(rows, 24), .cols = clampDim(cols, 80), .xpixel = 0, .ypixel = 0 };
        const pid = forkpty(&master, null, null, @ptrCast(&size));
        if (pid < 0) return error.ForkFailed;
        if (pid == 0) {
            // Same environment an SSH login gets, so prompt, colours,
            // readline and UTF-8 (Cyrillic, btop) behave identically.
            _ = setenv("TERM", "xterm-256color", 1);
            _ = setenv("COLORTERM", "truecolor", 1);
            _ = setenv("LANG", "en_US.UTF-8", 1);
            _ = setenv("LC_ALL", "en_US.UTF-8", 1);
            _ = setenv("HOME", "/root", 1);
            _ = setenv("USER", "root", 1);
            _ = setenv("LOGNAME", "root", 1);
            _ = setenv("PATH", "/opt/bin:/opt/sbin:/usr/bin:/bin:/usr/sbin:/sbin", 1);
            _ = chdir("/root");
            switch (shell) {
                .bash => {
                    _ = setenv("SHELL", "/opt/bin/bash", 1);
                    // Login shell, exactly like sshd: reads .bash_profile -> .bashrc.
                    _ = execl("/opt/bin/bash", "-bash", @as(?[*:0]const u8, null));
                },
                .sh => {
                    _ = setenv("SHELL", "/bin/sh", 1);
                    _ = execl("/bin/sh", "-sh", @as(?[*:0]const u8, null));
                },
            }
            std.posix.exit(127);
        }
        const fd: std.posix.fd_t = @intCast(master);
        const flags: usize = std.posix.fcntl(fd, std.posix.F.GETFL, 0) catch 0;
        const nonblock: usize = @as(usize, @bitCast(std.posix.O{ .NONBLOCK = true }));
        _ = std.posix.fcntl(fd, std.posix.F.SETFL, flags | nonblock) catch {};
        return .{ .fd = fd, .pid = pid };
    }

    pub fn resize(self: *Session, cols: u16, rows: u16) void {
        if (cols == 0 or rows == 0) return;
        const size = WinSize{ .rows = rows, .cols = cols, .xpixel = 0, .ypixel = 0 };
        _ = ioctl(self.fd, TIOCSWINSZ, @intFromPtr(&size));
    }

    pub fn write(self: *Session, data: []const u8) !void {
        var offset: usize = 0;
        while (offset < data.len) {
            const written = std.posix.write(self.fd, data[offset..]) catch |err| switch (err) {
                error.WouldBlock => {
                    var fds = [_]std.posix.pollfd{.{ .fd = self.fd, .events = std.posix.POLL.OUT, .revents = 0 }};
                    _ = std.posix.poll(&fds, 100) catch {};
                    continue;
                },
                else => return err,
            };
            if (written == 0) return error.WriteFailed;
            offset += written;
        }
    }

    /// Waits up to `timeout_ms` for output. Returns the number of bytes read,
    /// 0 on timeout, or error.EndOfStream when the shell has exited.
    pub fn readInto(self: *Session, buffer: []u8, timeout_ms: i32) !usize {
        var fds = [_]std.posix.pollfd{.{ .fd = self.fd, .events = std.posix.POLL.IN, .revents = 0 }};
        const ready = try std.posix.poll(&fds, timeout_ms);
        if (ready == 0) return 0;
        if (fds[0].revents & std.posix.POLL.IN == 0 and fds[0].revents & (std.posix.POLL.HUP | std.posix.POLL.ERR) != 0) return error.EndOfStream;
        return std.posix.read(self.fd, buffer) catch |err| switch (err) {
            error.WouldBlock => 0,
            error.InputOutput => error.EndOfStream,
            else => err,
        };
    }

    /// Hangs up the whole PTY session, not only the shell: full-screen programs
    /// (btop) run in their own process group and used to survive as orphans.
    pub fn close(self: *Session) void {
        if (self.closed.swap(true, .acq_rel)) return;
        signalSession(self.pid, std.posix.SIG.HUP);
        std.posix.close(self.fd);
        _ = std.posix.waitpid(self.pid, 0);
        std.Thread.sleep(200 * std.time.ns_per_ms);
        signalSession(self.pid, std.posix.SIG.KILL);
    }
};

/// Sends `sig` to every process whose session id is `sid` (field 6 of /proc/<pid>/stat).
fn signalSession(sid: std.posix.pid_t, sig: u8) void {
    var dir = std.fs.openDirAbsolute("/proc", .{ .iterate = true }) catch return;
    defer dir.close();
    var it = dir.iterate();
    while (it.next() catch null) |entry| {
        const pid = std.fmt.parseInt(std.posix.pid_t, entry.name, 10) catch continue;
        var path_buf: [32]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "/proc/{d}/stat", .{pid}) catch continue;
        const file = std.fs.openFileAbsolute(path, .{}) catch continue;
        defer file.close();
        var buf: [512]u8 = undefined;
        const count = file.read(&buf) catch continue;
        const data = buf[0..count];
        // "pid (comm) state ppid pgrp session ..."; comm may contain spaces.
        const paren = std.mem.lastIndexOfScalar(u8, data, ')') orelse continue;
        var fields = std.mem.tokenizeScalar(u8, data[paren + 1 ..], ' ');
        _ = fields.next(); // state
        _ = fields.next(); // ppid
        _ = fields.next(); // pgrp
        const session = std.fmt.parseInt(std.posix.pid_t, fields.next() orelse continue, 10) catch continue;
        if (session == sid) std.posix.kill(pid, sig) catch {};
    }
}

fn clampDim(value: u16, fallback: u16) u16 {
    return if (value == 0 or value > 1000) fallback else value;
}
