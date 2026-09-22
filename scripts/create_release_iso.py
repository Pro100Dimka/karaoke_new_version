from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

import pycdlib


def _iso_component(name: str, relative: str, directory: bool) -> str:
    cleaned = re.sub(r"[^A-Z0-9_]", "_", name.upper())
    digest = hashlib.sha1(relative.encode("utf-8")).hexdigest()[:4].upper()
    if directory:
        return f"{cleaned[:3]}_{digest}"
    stem, suffix = Path(cleaned).stem, Path(cleaned).suffix.lstrip(".")
    extension = (suffix[:3] or "BIN").upper()
    return f"{stem[:3]}_{digest}.{extension};1"


def create_iso(source: Path, output: Path) -> None:
    if not source.is_dir():
        raise SystemExit(f"Release stage does not exist: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    image = pycdlib.PyCdlib()
    image.new(interchange_level=3, joliet=3, vol_ident="ADVOICE")
    image.add_directory(iso_path="/ADVOICE", joliet_path="/AD-Voice")
    iso_paths = {source: "/ADVOICE"}
    joliet_paths = {source: "/AD-Voice"}
    for item in sorted(source.rglob("*"), key=lambda path: (len(path.parts), str(path))):
        parent_iso = iso_paths[item.parent]
        parent_joliet = joliet_paths[item.parent]
        relative = item.relative_to(source).as_posix()
        iso_name = _iso_component(item.name, relative, item.is_dir())
        iso_path = f"{parent_iso}/{iso_name}"
        joliet_path = f"{parent_joliet}/{item.name}"
        if item.is_dir():
            image.add_directory(iso_path=iso_path, joliet_path=joliet_path)
            iso_paths[item] = iso_path
            joliet_paths[item] = joliet_path
        else:
            image.add_file(str(item), iso_path=iso_path, joliet_path=joliet_path)
    image.write(str(output))
    image.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: create_release_iso.py SOURCE_DIR OUTPUT.iso")
    create_iso(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
