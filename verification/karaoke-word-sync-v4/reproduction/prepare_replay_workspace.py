"""Create a separate portable working copy; do not run models or modify evidence."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--destination', type=Path, required=True)
parser.add_argument('--project', type=Path, required=True)
parser.add_argument('--baseline', type=Path)
args = parser.parse_args()
source = args.source.resolve()
destination = args.destination.resolve()
if destination == source or source in destination.parents or destination.exists():
    raise ValueError('Use a new destination outside the original evidence directory')
if not (args.project.resolve() / 'python/backend').is_dir():
    raise ValueError('--project must identify the project containing python/backend')
replacements = {
    '/tmp/karaoke-sync-v4': str(destination),
    '/workspace/scratch/513dbcd967bf/project/karaoke_new_version-refactor-frontend-direct': str(args.project.resolve()),
}
if args.baseline:
    replacements['/workspace/scratch/513dbcd967bf/baseline-v3/karaoke_new_version-refactor-frontend-direct'] = str(args.baseline.resolve())
text_suffixes = {'.py', '.json', '.md', '.txt', '.log', '.sha256', '.TextGrid'}
destination.mkdir(parents=True)
records = []
for original in sorted(source.rglob('*')):
    if original.is_symlink():
        raise ValueError(f'Unexpected symlink: {original}')
    if not original.is_file():
        continue
    relative = original.relative_to(source)
    target = destination / relative
    raw = original.read_bytes()
    content = raw
    if original.suffix in text_suffixes:
        text = raw.decode('utf-8')
        for before, after in replacements.items():
            text = text.replace(before, after)
        content = text.encode('utf-8')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    records.append({'path': str(relative), 'originalSha256': hashlib.sha256(raw).hexdigest(),
                    'workingCopySha256': hashlib.sha256(content).hexdigest(), 'pathsChanged': content != raw})
report = {'createdAtUtc': datetime.now(timezone.utc).isoformat(),
          'scope': 'Path relocation only; original evidence untouched. No inference or downloads.',
          'replacements': replacements, 'files': records,
          'hashNotice': 'STAGING hashes describe original evidence; use WORKSPACE-FILES.sha256 for this relocated copy.'}
(destination / 'RELOCATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
(destination / 'WORKSPACE-FILES.sha256').write_text(
    '\n'.join(f"{row['workingCopySha256']}  {row['path']}" for row in records) + '\n')
print(destination)
