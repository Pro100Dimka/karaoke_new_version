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
native_config="/etc/systemd/system/karaoke-room-server.service.d/native-relay.conf"
config_backup="$root/native-relay.backup-$stamp.conf"
restore_paths=("$root/pyproject.toml" "$root/bin/NativeVoiceRelay" "$native_config")
restore_backups=("$pyproject_backup" "$native_backup" "$config_backup")
rollback_armed=false
stage_created=false

cleanup() {
    if $stage_created; then rm -rf -- "$stage"; fi
    rm -f -- "$archive" "/tmp/deploy-room-server-$stamp.sh"
}
finish_deployment() {
    local status=$?
    trap - EXIT INT TERM
    set +e
    if (( status != 0 )) && $rollback_armed; then rollback; fi
    cleanup
    exit "$status"
}
trap finish_deployment EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A reused stamp must not overwrite the only recovery copy from an earlier attempt.
for path in "$stage" "$backup" "$failed" "${restore_backups[@]}"; do
    [[ ! -e "$path" && ! -L "$path" ]] || { echo "Deployment path already exists: $path" >&2; exit 2; }
done

mkdir "$stage"
stage_created=true
tar -xzf "$archive" -C "$stage"
test -f "$stage/backend/room_server_main.py"
test -f "$stage/backend/api/room_server_app.py"
test -f "$stage/AudioService/src/relay/NativeVoiceRelay.cpp"
test -f "$stage/AudioService/src/relay/NativeVoiceRelayMain.cpp"
test -f "$stage/AudioService/src/network/NetworkPacket.hpp"
test -f "$stage/AudioService/src/network/RoomAudioContract.hpp"
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
    local status=0
    sudo systemctl stop karaoke-room-server.service || status=1
    if [[ -d "$backup" ]]; then
        if [[ ! -d "$root/backend" ]] || sudo mv "$root/backend" "$failed"; then
            sudo mv "$backup" "$root/backend" || status=1
        else
            status=1
        fi
    fi
    for index in "${!restore_paths[@]}"; do
        if [[ -f "${restore_backups[$index]}" ]]; then
            sudo cp -p "${restore_backups[$index]}" "${restore_paths[$index]}" || status=1
        else
            sudo rm -f -- "${restore_paths[$index]}" || status=1
        fi
    done
    sudo systemctl daemon-reload || status=1
    sudo systemctl start karaoke-room-server.service || status=1
    sleep 3
    sudo systemctl is-active --quiet karaoke-room-server.service || status=1
    curl -fsS http://127.0.0.1:8081/health/ready >/dev/null || status=1
    if (( status == 0 )); then
        echo "ROOM_SERVER_ROLLBACK=restored"
    else
        echo "ROOM_SERVER_ROLLBACK=failed; inspect preserved backups under $root" >&2
    fi
    return "$status"
}

# Snapshot every replaced file before stopping the currently serving version.
test -f "$root/pyproject.toml"
sudo mkdir -p "$root/bin"
for index in "${!restore_paths[@]}"; do
    if [[ -f "${restore_paths[$index]}" ]]; then
        sudo cp -p "${restore_paths[$index]}" "${restore_backups[$index]}"
    fi
done
rollback_armed=true
sudo systemctl stop karaoke-room-server.service
sudo mv "$root/backend" "$backup"
sudo mv "$stage/backend" "$root/backend"
sudo cp "$stage/pyproject.toml" "$root/pyproject.toml"
sudo cp "$stage/NativeVoiceRelay" "$root/bin/NativeVoiceRelay"
sudo chmod 755 "$root/bin/NativeVoiceRelay"
sudo mkdir -p /etc/systemd/system/karaoke-room-server.service.d
printf '%s\n' '[Service]' \
    'Environment=AD_VOICE_NATIVE_RELAY_EXECUTABLE=/opt/karaoke-room-server/bin/NativeVoiceRelay' \
    'AmbientCapabilities=CAP_SYS_NICE' \
    'CapabilityBoundingSet=CAP_SYS_NICE' \
    | sudo tee "$native_config" >/dev/null
sudo systemctl daemon-reload
sudo chown -R ubuntu:ubuntu "$root/backend" "$root/pyproject.toml" "$root/bin/NativeVoiceRelay"

sudo systemctl start karaoke-room-server.service

sleep 3
curl -fsS http://127.0.0.1:8081/health/ready >/dev/null
curl -fsS http://127.0.0.1:8081/openapi.json | grep '"/rooms/{room_id}/changes"' >/dev/null

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
    exit 1
fi
echo "Room Server is active on $HOSTNAME"
