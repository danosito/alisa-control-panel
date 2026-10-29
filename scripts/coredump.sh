#!/bin/sh
# Fetch the latest crash from the station and open it in gdb with the device's
# shared libraries as sysroot. The matching binary comes from the local
# archive written by scripts/deploy.sh (zig-out/archive/<md5>/alisa-panel), or
# from the device when the running build is still the crashed one.
#   scripts/coredump.sh        # interactive gdb
#   scripts/coredump.sh --bt   # just print backtraces of all threads
set -eu
. "$(dirname "$0")/common.sh"
OUT=${TMPDIR:-/tmp}/$APP-crash
latest=$($SSH "ls -1dt /data/opt/var/$APP/cores/*/ 2>/dev/null | head -n 1")
[ -n "$latest" ] || { echo "no crashes recorded on the device"; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT/sysroot"
$SSH "cat $latest/core.gz" | gunzip > "$OUT/core"
$SSH "cat $latest/info" > "$OUT/info"
md5=$(sed -n 's/^binary_md5: //p' "$OUT/info")
if [ -n "$md5" ] && [ -f "$ROOT/zig-out/archive/$md5/alisa-panel" ]; then
  cp "$ROOT/zig-out/archive/$md5/alisa-panel" "$OUT/binary"
elif [ "$($SSH "md5sum /data/opt/bin/$APP" | cut -d' ' -f1)" = "$md5" ]; then
  $SSH "cat /data/opt/bin/$APP" > "$OUT/binary"
else
  echo "binary $md5 is neither archived locally nor running on the device" >&2; exit 1
fi
# Libraries the process mapped, for symbolised libc/pthread frames.
$SSH 'tar -cf - /lib/libc.so.6 /lib/libc-2.30.so /lib/libpthread.so.0 /lib/libpthread-2.30.so /lib/ld-linux-armhf.so.3 /lib/ld-2.30.so /lib/libutil.so.1 /lib/libutil-2.30.so 2>/dev/null' | tar -xf - -C "$OUT/sysroot"
echo "== $latest"; head -n 4 "$OUT/info"
if [ "${1:-}" = "--bt" ]; then
  gdb -q -batch -ex "set sysroot $OUT/sysroot" -ex "thread apply all bt full 20" "$OUT/binary" "$OUT/core"
else
  exec gdb -q -ex "set sysroot $OUT/sysroot" "$OUT/binary" "$OUT/core"
fi
