#!/bin/sh
# Build web + server, archive the binary by md5 (for core dumps), install it
# with the init scripts on the station and restart the panel.
#   scripts/deploy.sh            # full build and deploy
#   scripts/deploy.sh --no-web   # reuse the existing web bundle
set -eu
. "$(dirname "$0")/common.sh"
cd "$ROOT"
[ "${1:-}" = "--no-web" ] && [ -f src/index.html ] || (cd web && npm run --silent build)
zig build ${ZIG_FLAGS:-} -Dtarget=arm-linux-gnueabihf.2.30 -Doptimize=ReleaseSafe
md5=$(md5 -q zig-out/bin/alisa-panel 2>/dev/null || md5sum zig-out/bin/alisa-panel | cut -d' ' -f1)
mkdir -p "zig-out/archive/$md5" && cp zig-out/bin/alisa-panel "zig-out/archive/$md5/alisa-panel"
ls -1dt zig-out/archive/*/ | tail -n +11 | xargs rm -rf 2>/dev/null || true

# Scripts are templates: APP=... is set to the install name.
install_script() { sed "s/^APP=alisa-panel /APP=$APP /" "$1" | $SSH "cat > $2.new && chmod 755 $2.new"; }
install_script deploy/panel-supervise "/data/opt/bin/$APP-supervise"
install_script deploy/panel-btguard "/data/opt/bin/$APP-btguard"
install_script deploy/S98panel "/etc/init.d/S98$APP"
$SSH "mkdir -p /data/opt/etc/$APP /data/opt/share/$APP/assets"
if ! $SSH "[ -f /data/opt/etc/$APP/panel.env ]"; then
  $SSH "umask 077; cat > /data/opt/etc/$APP/panel.env" < deploy/panel.env.example
  echo "installed /data/opt/etc/$APP/panel.env from the example: set PANEL_PASSWORD (or passkey settings) there" >&2
fi
$SSH "/etc/init.d/S98$APP stop" || true
cat zig-out/bin/alisa-panel | $SSH "cat > /data/opt/bin/$APP.new && chmod 755 /data/opt/bin/$APP.new"
$SSH "cd /data/opt/bin && mv $APP.new $APP && mv $APP-supervise.new $APP-supervise && mv $APP-btguard.new $APP-btguard && mv /etc/init.d/S98$APP.new /etc/init.d/S98$APP && /etc/init.d/S98$APP start && sleep 3 && tail -n 3 /data/opt/etc/$APP/$APP.log"
echo "deployed $md5 as $APP"
