#!/bin/sh
set -eu
: "${MONITOR_IMAGE:?MONITOR_IMAGE is required}"
: "${GHCR_USER:?GHCR_USER is required}"
: "${GHCR_TOKEN:?GHCR_TOKEN is required}"

name=100my-page-monitor
previous=100my-page-monitor-previous
network="${APP_NETWORK:-100my-page-network}"
env_file="${MONITOR_ENV_FILE:-/opt/100my-page/monitor.env}"
volume=100my-page-monitor-data
saved=false
created=false
committed=false
was_running=false
temp=$(mktemp -d)
finish() {
    result=$?
    trap - EXIT HUP INT TERM
    if [ "$committed" = false ]; then
        if [ "$created" = true ]; then docker rm -f "$name" || true; fi
        if [ "$saved" = true ]; then
            docker rename "$previous" "$name" || true
            if [ "$was_running" = true ]; then docker start "$name" || true; fi
        fi
    fi
    rm -rf "$temp"
    exit "$result"
}
trap finish EXIT
trap 'exit 143' HUP INT TERM
exec 9>"${DEPLOY_LOCK_FILE:-/var/lock/100my-page-deploy.lock}"
flock -w 900 9
if docker container inspect "$previous" >/dev/null 2>&1; then
    echo 'Unresolved monitor rollback backup exists.' >&2; exit 1
fi
test -s "$env_file" || { echo 'Missing server-side monitor.env' >&2; exit 1; }
printf '%s' "$GHCR_TOKEN" | docker --config "$temp" login ghcr.io -u "$GHCR_USER" --password-stdin
docker --config "$temp" pull "$MONITOR_IMAGE"
docker run --rm --network none "$MONITOR_IMAGE" node --check server.mjs
docker network inspect "$network" >/dev/null
docker volume inspect "$volume" >/dev/null 2>&1 || docker volume create "$volume"
if docker container inspect "$name" >/dev/null 2>&1; then
    was_running=$(docker inspect --format '{{.State.Running}}' "$name")
    docker rename "$name" "$previous"
    saved=true
    docker stop "$previous"
fi
docker create --name "$name" --restart=unless-stopped \
    --network "$network" --network-alias page-monitor \
    --env-file "$env_file" --mount "type=volume,src=$volume,dst=/app/data" \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,size=8m \
    --memory 192m --memory-swap 192m --cpus 0.5 --pids-limit 48 \
    --log-driver json-file --log-opt max-size=5m --log-opt max-file=2 \
    "$MONITOR_IMAGE"
created=true
docker start "$name"
attempt=0
while [ "$attempt" -lt 30 ]; do
    state=$(docker inspect --format '{{.State.Health.Status}}' "$name")
    [ "$state" != unhealthy ] || exit 1
    [ "$state" != healthy ] || break
    attempt=$((attempt + 1)); sleep 2
done
[ "$state" = healthy ] || exit 1
# Verify public access without credentials.
docker exec "$name" node --input-type=module -e '
const root="http://127.0.0.1:4318/3D/monitor/";
for(const path of ["","monitor.js","style.css","app.js"]) if(!(await fetch(root+path)).ok) process.exit(1);
if(!(await fetch(root+"api/events")).ok) process.exit(1);
'
committed=true
if [ "$saved" = true ]; then docker rm "$previous"; fi
echo 'Monitor deployment is healthy.'
