"""Build Inno language declarations from the application's language list."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

LANGUAGE_FILES = {"en": "Default.isl", "ru": "Languages\\Russian.isl", "uk": "Languages\\Ukrainian.isl"}


def main() -> None:
    languages = json.loads((ROOT / "frontend/src/i18n/languages.json").read_text(encoding="utf-8"))
    lines = ["[Languages]"]
    for locale in languages:
        lines.append(f'Name: "{locale}"; MessagesFile: "compiler:{LANGUAGE_FILES[locale]}"')
    Path(sys.argv[1]).write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


if __name__ == "__main__":
    main()
