#!/usr/bin/env bash
set -euo pipefail
stage="${1:?staging directory required}"
[[ "$stage" =~ ^/tmp/ad-voice-processing-[0-9]{8}-[0-9]{6}$ ]] || exit 2
root=/opt/karaoke-processing-server
site=/etc/nginx/sites-available/room-server
unit=/etc/systemd/system/ad-voice-processing.service
paths=("$root/processing-server.py" /etc/ad-voice-processing.env "$unit" /etc/nginx/snippets/ad-voice-processing.conf "$site")
rollback_armed=false
was_active=false
was_enabled=false
sudo systemctl is-active --quiet ad-voice-processing.service && was_active=true
sudo systemctl is-enabled --quiet ad-voice-processing.service && was_enabled=true

rollback() {
    local status=0
    sudo systemctl stop ad-voice-processing.service || status=1
    for index in "${!paths[@]}"; do
        if sudo test -f "$stage/processing-before-$index"; then
            sudo cp -p "$stage/processing-before-$index" "${paths[$index]}" || status=1
        else
            sudo rm -f -- "${paths[$index]}" || status=1
        fi
    done
    sudo systemctl daemon-reload || status=1
    if $was_enabled; then
        sudo systemctl enable ad-voice-processing.service || status=1
    else
        sudo systemctl disable ad-voice-processing.service || status=1
    fi
    if $was_active; then
        sudo systemctl start ad-voice-processing.service || status=1
        sudo systemctl is-active --quiet ad-voice-processing.service || status=1
    fi
    sudo nginx -t && sudo systemctl reload nginx || status=1
    if (( status == 0 )); then
        echo 'PROCESSING_SERVER_ROLLBACK=restored'
    else
        echo 'PROCESSING_SERVER_ROLLBACK=failed; inspect preserved staging backups' >&2
    fi
    return "$status"
}
finish_deployment() {
    local status=$?
    trap - EXIT INT TERM
    set +e
    if (( status != 0 )) && $rollback_armed; then rollback; fi
    exit "$status"
}
trap finish_deployment EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$root/data/queue.sqlite3" <<'PY'
import sqlite3
import sys
from pathlib import Path

path = Path(sys.argv[1])
if path.is_file():
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        if db.execute("SELECT 1 FROM jobs WHERE state IN ('uploading','queued','running') LIMIT 1").fetchone():
            raise SystemExit("Processing jobs are active; deployment was not activated")
        columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
        if "owner" not in columns and db.execute("SELECT 1 FROM jobs LIMIT 1").fetchone():
            raise SystemExit("Clear the legacy processing queue before upgrading privacy storage")
PY

# Preserve the whole replaced configuration before changing any serving file.
for index in "${!paths[@]}"; do
    [[ ! -e "$stage/processing-before-$index" ]] || exit 2
done
for index in "${!paths[@]}"; do
    if sudo test -f "${paths[$index]}"; then
        sudo cp -p "${paths[$index]}" "$stage/processing-before-$index"
    fi
done
rollback_armed=true
if ! sudo test -d "$root/data"; then
    sudo install -d -m 700 -o ubuntu -g ubuntu "$root/data"
fi
sudo install -m 644 "$stage/processing-server.py" "$root/processing-server.py"
sudo install -m 600 "$stage/server.env" /etc/ad-voice-processing.env
sudo install -m 644 "$stage/processing-server.service" /etc/systemd/system/ad-voice-processing.service
sudo install -m 644 "$stage/processing-proxy.conf" /etc/nginx/snippets/ad-voice-processing.conf
sudo python3 - "$site" <<'PY'
import sys
import re
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
line = '    include /etc/nginx/snippets/ad-voice-processing.conf;'
if line not in text:
    anchor = '    client_max_body_size 0;'
    if text.count(anchor) != 1:
        raise SystemExit('Expected one room HTTPS server block')
    text = text.replace(anchor, anchor + '\n' + line)
text = re.sub(
    r"(?m)^([ \t]*)server\s*\{[ \t]*\n(?![ \t]*access_log off;\n[ \t]*error_log /dev/null crit;)",
    lambda match: match[0] + match[1] + "    access_log off;\n" + match[1] + "    error_log /dev/null crit;\n",
    text,
)
path.write_text(text)
PY
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now ad-voice-processing.service
sudo systemctl restart ad-voice-processing.service
processing_ready() {
    [[ "$(curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8083/processing/health)" == 403 ]]
}
healthy=false
for attempt in {1..15}; do
    if processing_ready; then
        healthy=true
        break
    fi
    sleep 1
done
$healthy || { echo 'Processing relay did not become healthy' >&2; exit 1; }
sudo systemctl is-active --quiet ad-voice-processing.service
sudo systemctl reload nginx
processing_ready
curl -fsS http://127.0.0.1:8081/health/ready >/dev/null
echo 'Processing relay active; room service remains online.'
