from __future__ import annotations

import re
import tomllib
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]


def _name(requirement: str) -> str:
    return re.split(r"[=<>~!; \[]", requirement.strip(), maxsplit=1)[0].lower().replace("_", "-")


def test_every_declared_dependency_is_pinned_in_the_lock_file() -> None:
    # installer.bat installs strictly from requirements.lock (the project itself with --no-deps):
    # a dependency missing there never reaches a new computer (shazamio once crashed start-up).
    project = tomllib.loads((_ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    declared = {_name(item) for item in project["dependencies"]}
    lines = (_ROOT / "requirements.lock").read_text(encoding="utf-8").splitlines()
    locked = {_name(line) for line in lines if line.strip() and not line.startswith("#")}

    assert sorted(declared - locked) == []


def test_python_313_has_the_removed_audioop_runtime() -> None:
    expected = 'audioop-lts==0.2.2; python_version >= "3.13"'
    lock = (_ROOT / "requirements.lock").read_text(encoding="utf-8")
    project = (_ROOT / "pyproject.toml").read_text(encoding="utf-8")

    assert expected in lock
    assert expected.replace('"3.13"', "'3.13'") in project
