#!/usr/bin/env bash
set -euo pipefail
stage="${1:?staging directory required}"
[[ "$stage" =~ ^/tmp/ad-voice-processing-[0-9]{8}-[0-9]{6}$ ]] || exit 2
root=/opt/karaoke-processing-server
site=/etc/nginx/sites-available/room-server
backup="$stage/room-server.before"
sudo cp -p "$site" "$backup"
sudo mkdir -p "$root/data"
sudo chown ubuntu:ubuntu "$root/data"
sudo chmod 700 "$root/data"
if sudo test -f "$root/processing-server.py"; then
    sudo cp -p "$root/processing-server.py" "$stage/processing-server.before"
fi
sudo install -m 644 "$stage/processing-server.py" "$root/processing-server.py"
sudo install -m 600 "$stage/server.env" /etc/ad-voice-processing.env
sudo install -m 644 "$stage/processing-server.service" /etc/systemd/system/ad-voice-processing.service
sudo install -m 644 "$stage/processing-proxy.conf" /etc/nginx/snippets/ad-voice-processing.conf
sudo python3 - "$site" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
text = path.read_text()
line = '    include /etc/nginx/snippets/ad-voice-processing.conf;'
if line not in text:
    anchor = '    client_max_body_size 0;'
    if text.count(anchor) != 1:
        raise SystemExit('Expected one room HTTPS server block')
    path.write_text(text.replace(anchor, anchor + '\n' + line))
PY
rollback() {
    sudo cp -p "$backup" "$site"
    if test -f "$stage/processing-server.before"; then
        sudo cp -p "$stage/processing-server.before" "$root/processing-server.py"
        sudo systemctl restart ad-voice-processing.service
    else
        sudo systemctl stop ad-voice-processing.service || true
    fi
    sudo nginx -t && sudo systemctl reload nginx
}
trap rollback ERR
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now ad-voice-processing.service
sudo systemctl restart ad-voice-processing.service
for attempt in {1..15}; do
    if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8083/processing/health | grep -q '^403$'; then
        break
    fi
    sleep 1
done
sudo systemctl is-active --quiet ad-voice-processing.service
sudo systemctl reload nginx
curl -fsS http://127.0.0.1:8081/health/ready >/dev/null
echo 'Processing relay active; room service remains online.'
