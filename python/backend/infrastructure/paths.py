from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath

from backend.domain_errors import DomainError


def ensure_within(path: Path, root: Path) -> Path:
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    if resolved_path == resolved_root or resolved_root in resolved_path.parents:
        return resolved_path
    raise DomainError("PathOutsideAllowedRoot", "Path is outside the allowed root", 400)


def safe_relative_path(value: str) -> Path:
    if not value or "\x00" in value:
        raise DomainError("InvalidPath", "Unsafe relative path", 400, {"path": value})

    windows = PureWindowsPath(value)
    posix = PurePosixPath(value.replace("\\", "/"))
    unsafe = (
        windows.is_absolute()
        or bool(windows.drive)
        or posix.is_absolute()
        or ".." in windows.parts
        or ".." in posix.parts
    )
    if unsafe:
        raise DomainError("InvalidPath", "Unsafe relative path", 400, {"path": value})
    return Path(*posix.parts)
