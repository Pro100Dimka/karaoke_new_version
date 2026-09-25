from __future__ import annotations

from pathlib import Path

from backend.domain_errors import DomainError
from backend.storage.path_policy import portable_component, portable_relative_path


def ensure_within(path: Path, root: Path) -> Path:
    resolved_root = root.resolve()
    resolved_path = path.resolve()
    if resolved_path == resolved_root or resolved_root in resolved_path.parents:
        return resolved_path
    raise DomainError("PathOutsideAllowedRoot", "Path is outside the allowed root", 400)


def safe_relative_path(value: str) -> Path:
    try:
        return Path(*portable_relative_path(value).parts)
    except ValueError as exc:
        raise DomainError("InvalidPath", "Unsafe relative path", 400, {"path": value}) from exc


def safe_path_component(value: str) -> str:
    try:
        return portable_component(value)
    except ValueError as exc:
        raise DomainError("InvalidPath", "Unsafe path component", 400, {"path": value}) from exc
