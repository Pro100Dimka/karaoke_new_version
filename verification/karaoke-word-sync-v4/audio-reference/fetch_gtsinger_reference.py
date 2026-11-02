"""Download pinned external validation data; no application models or code are changed."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

parser = argparse.ArgumentParser()
parser.add_argument('--destination', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).parent
entries = json.loads((root/'gtsinger-fetch-manifest.json').read_text())['files']
entries += json.loads((root/'additional-download-manifest.json').read_text())
seen = set()
for item in entries:
    key = item['relativePath']
    if key in seen:
        continue
    seen.add(key)
    path = args.destination/key
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
        with urlopen(item['url'], timeout=60) as response:
            content = response.read()
        if len(content) != item['size'] or hashlib.sha256(content).hexdigest() != item['sha256']:
            raise ValueError('External data integrity mismatch: '+key)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(content)
    print(key)
