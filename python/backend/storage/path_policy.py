from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath


def portable_relative_path(value: str) -> PurePosixPath:
    """Validate before joining: packages must have the same meaning on Windows and POSIX."""
    path = PurePosixPath(value.replace("\\", "/"))
    if not path.parts or path.is_absolute() or PureWindowsPath(value).drive:
        raise ValueError("Path must be relative")
    for part in path.parts:
        portable_component(part)
    return path


def portable_component(value: str) -> str:
    reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    stem = value.split(".", 1)[0].rstrip(" ").upper()
    numbered_device = len(stem) == 4 and stem[:3] in {"COM", "LPT"} and stem[3] in "123456789¹²³"
    if (
        not value
        or value.endswith((".", " "))
        or stem in reserved
        or numbered_device
        or any(ord(char) < 32 or char in '<>:"/\\|?*' for char in value)
    ):
        raise ValueError("Unsafe portable path component")
    return value
