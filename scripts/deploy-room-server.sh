#!/usr/bin/env bash
set -euo pipefail

stamp="${1:?deployment stamp is required}"
archive="${2:?archive path is required}"
[[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo "Invalid deployment stamp" >&2; exit 2; }
[[ "$archive" == "/tmp/karaoke-room-server-$stamp.tar.gz" ]] || { echo "Invalid archive path" >&2; exit 2; }

root="/opt/karaoke-room-server"
stage="/tmp/karaoke-room-server-deploy-$stamp"
backup="$root/backend.backup-$stamp"
failed="$root/backend.failed-$stamp"
pyproject_backup="$root/pyproject.backup-$stamp.toml"

cleanup() {
    rm -rf -- "$stage"
    rm -f -- "$archive" "/tmp/deploy-room-server-$stamp.sh"
}
trap cleanup EXIT

mkdir -p "$stage"
tar -xzf "$archive" -C "$stage"
test -f "$stage/backend/room_server_main.py"
test -f "$stage/backend/api/room_server_app.py"
"$root/.venv/bin/python" -m compileall -q "$stage/backend"
(
    cd "$stage"
    PYTHONPATH="$stage" "$root/.venv/bin/python" -c \
        "from backend.api.room_server_app import create_room_server_app; assert create_room_server_app(relay_port=0).title"
)

rollback() {
    sudo systemctl stop karaoke-room-server.service || true
    if [[ -d "$root/backend" ]]; then sudo mv "$root/backend" "$failed"; fi
    sudo mv "$backup" "$root/backend"
    sudo cp "$pyproject_backup" "$root/pyproject.toml"
    sudo systemctl start karaoke-room-server.service
}

sudo systemctl stop karaoke-room-server.service
sudo mv "$root/backend" "$backup"
sudo cp "$root/pyproject.toml" "$pyproject_backup"
sudo mv "$stage/backend" "$root/backend"
sudo cp "$stage/pyproject.toml" "$root/pyproject.toml"
sudo chown -R ubuntu:ubuntu "$root/backend" "$root/pyproject.toml"

if ! sudo systemctl start karaoke-room-server.service; then
    rollback
    exit 1
fi

sleep 3
if ! curl -fsS http://127.0.0.1:8081/health/ready >/dev/null; then
    rollback
    exit 1
fi
if ! curl -fsS http://127.0.0.1:8081/openapi.json | grep -q '"/rooms/{room_id}/changes"'; then
    rollback
    exit 1
fi

sudo systemctl is-active --quiet karaoke-room-server.service
echo "Room Server is active on $HOSTNAME"
