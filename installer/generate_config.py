"""Build Inno language declarations and content-verified payload entries."""

from __future__ import annotations

import json
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

LANGUAGE_FILES = {
    "en": "Default.isl",
    "ru": "Languages\\Russian.isl",
    "uk": "Languages\\Ukrainian.isl",
}


def main() -> None:
    languages = json.loads(
        (ROOT / "frontend/src/i18n/languages.json").read_text(encoding="utf-8")
    )
    lines = ["[Languages]"]
    for locale in languages:
        lines.append(
            f'Name: "{locale}"; MessagesFile: "compiler:{LANGUAGE_FILES[locale]}"'
        )
    payload = Path(sys.argv[2])
    if not payload.is_dir():
        raise ValueError("Installer payload directory is missing")
    lines.append("[Files]")
    previous_group = None
    for source in sorted(payload.rglob("*")):
        relative = source.relative_to(payload)
        if not source.is_file() or relative.parts[0].lower() == "data":
            continue
        name = str(relative)
        destination = str(relative.parent)
        group = (
            relative.parts[:2]
            if relative.parts[0] == "resources"
            else relative.parts[:1]
        )
        flags = "ignoreversion"
        if group != previous_group or source.stat().st_size >= 16 * 1024**2:
            flags += " solidbreak"
        previous_group = group
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        quoted_name = name.replace("'", "''")
        lines.append(
            f'Source: "{{#AppSource}}\\{name}"; DestDir: "{{app}}\\{destination}"; '
            f"Flags: {flags}; Check: FileNeedsUpdate('{quoted_name}', '{digest}')"
        )
    Path(sys.argv[1]).write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


if __name__ == "__main__":
    main()
