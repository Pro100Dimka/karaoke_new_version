"""Generate the renderer's complete default casefold data from the backend's Python.

Run with Python 3.12 (Unicode 15.0.0):
    python frontend/scripts/generate-search-casefold.py [--check]

This supplies case folding only. NFKC remains the renderer's native normalization;
its Unicode version is not guaranteed to equal Python's normalization version.
"""

import argparse
import json
from pathlib import Path
import unicodedata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check without writing")
    args = parser.parse_args()
    if unicodedata.unidata_version != "15.0.0":
        raise SystemExit("Use Python with Unicode 15.0.0; review Unicode upgrades explicitly")

    mappings = {}
    for codepoint in range(0x110000):
        char = chr(codepoint)
        folded = char.casefold()
        if folded != char:
            mappings[str(codepoint)] = folded
    content = json.dumps(
        {"unicodeVersion": unicodedata.unidata_version, "mappings": mappings},
        ensure_ascii=True,
        indent=2,
    ) + "\n"
    target = (
        Path(__file__).resolve().parent.parent
        / "src/shared/utils/searchCasefold.generated.json"
    )
    if args.check:
        if not target.exists() or target.read_text(encoding="utf-8") != content:
            raise SystemExit("Casefold data differs; regenerate with this script")
    else:
        target.write_text(content, encoding="utf-8")
    print(f"Unicode {unicodedata.unidata_version}: {len(mappings)} casefold mappings")


if __name__ == "__main__":
    main()
