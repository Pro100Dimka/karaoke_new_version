import json
import os
from pathlib import Path
import signal
import time

captures = {
    285394: '/tmp/karaoke-2026-10-08-kernel-arrival.pcap',
    285608: '/tmp/karaoke-2026-10-08-kernel-arrival-all.pcap',
    285872: '/tmp/karaoke-2026-10-08-kernel-arrival-final.pcap',
    286057: '/tmp/karaoke-2026-10-08-kernel-arrival-short.pcap',
}
identities = {}
for pid, name in captures.items():
    path = Path(name)
    assert path.is_file() and not path.is_symlink() and str(path.resolve()) == name, name
    args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    expected = [b'tcpdump', b'-i', b'enp0s6', b'-s', b'128', b'-nn', b'-U',
                b'-w', name.encode(), b'udp', b'port', b'40000', b'']
    assert args == expected, (pid, 'Unexpected process command')
    stat = path.stat()
    identities[name] = (stat.st_dev, stat.st_ino)
for pid in captures:
    os.kill(pid, signal.SIGINT)
deadline = time.monotonic() + 10
while any(Path(f'/proc/{pid}').exists() for pid in captures) and time.monotonic() < deadline:
    time.sleep(0.2)
assert all(not Path(f'/proc/{pid}').exists() for pid in captures), 'Capture still alive; no files removed'
removed = {}
for name, identity in identities.items():
    path = Path(name)
    stat = path.stat()
    assert not path.is_symlink() and (stat.st_dev, stat.st_ino) == identity, name
    removed[name] = stat.st_size
    path.unlink()
space = os.statvfs('/tmp')
print(json.dumps({'removed': removed, 'available_bytes': space.f_bavail * space.f_frsize}))
