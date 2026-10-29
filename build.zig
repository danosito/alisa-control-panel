const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const passcay = b.dependency("passcay", .{ .target = target, .optimize = optimize });
    const tls = b.dependency("tls", .{ .target = target, .optimize = optimize });
    exe_module.addImport("passcay", passcay.module("passcay"));
    exe_module.addImport("tls", tls.module("tls"));

    const exe = b.addExecutable(.{
        .name = "alisa-panel",
        .root_module = exe_module,
    });
    exe.linkLibC();
    b.installArtifact(exe);

    // Unit tests of the device-independent parts (host target):
    //   zig build test
    const test_step = b.step("test", "Run unit tests");
    for ([_][]const u8{ "src/bluez.zig", "src/audio.zig", "src/lights.zig" }) |file| {
        const tests = b.addTest(.{ .root_module = b.createModule(.{ .root_source_file = b.path(file), .target = b.graph.host, .link_libc = true }) });
        test_step.dependOn(&b.addRunArtifact(tests).step);
    }

    const run = b.step("run", "Run the panel locally");
    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    run.dependOn(&run_cmd.step);
}
