from __future__ import annotations

from uuid import UUID


def normalize_room_id(value: str) -> str:
    """Canonicalize generated UUID room codes while preserving future non-UUID identifiers."""
    candidate = value.strip()
    try:
        return str(UUID(candidate))
    except ValueError:
        return candidate
