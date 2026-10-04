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
native_backup="$root/bin/NativeVoiceRelay.backup-$stamp"

cleanup() {
    rm -rf -- "$stage"
    rm -f -- "$archive" "/tmp/deploy-room-server-$stamp.sh"
}
trap cleanup EXIT

mkdir -p "$stage"
tar -xzf "$archive" -C "$stage"
test -f "$stage/backend/room_server_main.py"
test -f "$stage/backend/api/room_server_app.py"
test -f "$stage/AudioService/src/relay/NativeVoiceRelay.cpp"
test -f "$stage/AudioService/src/relay/NativeVoiceRelayMain.cpp"
test -f "$stage/AudioService/src/network/NetworkPacket.hpp"
"$root/.venv/bin/python" -m compileall -q "$stage/backend"
g++ -std=c++20 -O3 -DNDEBUG -pthread -I "$stage/AudioService/src" \
    "$stage/AudioService/src/relay/NativeVoiceRelay.cpp" \
    "$stage/AudioService/src/relay/NativeVoiceRelayMain.cpp" \
    -o "$stage/NativeVoiceRelay"
test -x "$stage/NativeVoiceRelay"
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
    if [[ -f "$native_backup" ]]; then
        sudo mv "$native_backup" "$root/bin/NativeVoiceRelay"
    else
        sudo rm -f "$root/bin/NativeVoiceRelay"
    fi
    sudo systemctl start karaoke-room-server.service
}

sudo systemctl stop karaoke-room-server.service
sudo mv "$root/backend" "$backup"
sudo cp "$root/pyproject.toml" "$pyproject_backup"
sudo mkdir -p "$root/bin"
if [[ -f "$root/bin/NativeVoiceRelay" ]]; then
    sudo cp "$root/bin/NativeVoiceRelay" "$native_backup"
fi
sudo mv "$stage/backend" "$root/backend"
sudo cp "$stage/pyproject.toml" "$root/pyproject.toml"
sudo cp "$stage/NativeVoiceRelay" "$root/bin/NativeVoiceRelay"
sudo chmod 755 "$root/bin/NativeVoiceRelay"
sudo mkdir -p /etc/systemd/system/karaoke-room-server.service.d
printf '%s\n' '[Service]' \
    'Environment=AD_VOICE_NATIVE_RELAY_EXECUTABLE=/opt/karaoke-room-server/bin/NativeVoiceRelay' \
    'AmbientCapabilities=CAP_SYS_NICE' \
    'CapabilityBoundingSet=CAP_SYS_NICE' \
    | sudo tee /etc/systemd/system/karaoke-room-server.service.d/native-relay.conf >/dev/null
sudo systemctl daemon-reload
sudo chown -R ubuntu:ubuntu "$root/backend" "$root/pyproject.toml" "$root/bin/NativeVoiceRelay"

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
test -x "$root/bin/NativeVoiceRelay"
pgrep -f "$root/bin/NativeVoiceRelay --port 40000" >/dev/null
relay_pid="$(pgrep -f "$root/bin/NativeVoiceRelay --port 40000" | head -n 1)"
realtime_thread_found=false
for thread in /proc/$relay_pid/task/*; do
    thread_id="${thread##*/}"
    if chrt -p "$thread_id" | grep -q 'SCHED_RR'; then
        realtime_thread_found=true
        break
    fi
done
if [ "$realtime_thread_found" != true ]; then
    rollback
    exit 1
fi
echo "Room Server is active on $HOSTNAME"
