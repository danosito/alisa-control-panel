# Shared by deploy.sh / coredump.sh: reads deploy.env and defines $SSH.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/deploy.env" ] || { echo "copy deploy.env.example to deploy.env and set HOST" >&2; exit 1; }
. "$ROOT/deploy.env"
: "${HOST:?HOST is not set in deploy.env}"
APP=${APP:-alisa-panel}
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -p ${SSH_PORT:-22}"
[ -n "${SSH_KEY:-}" ] && SSH="$SSH -o IdentitiesOnly=yes -i $SSH_KEY"
SSH="$SSH $HOST"
