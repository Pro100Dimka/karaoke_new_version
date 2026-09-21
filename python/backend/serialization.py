from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence, TypeAlias

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]


def _default(value: object) -> object:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def dumps(value: object, *, pretty: bool = False) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
        default=_default,
    )


def loads_object(text: str) -> dict[str, Any]:
    value = json.loads(text)
    if not isinstance(value, Mapping):
        raise ValueError("JSON document must be an object")
    return dict(value)


def loads_optional_object(text: str) -> dict[str, Any] | None:
    value = json.loads(text)
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("JSON document must be an object or null")
    return dict(value)


def loads_list(text: str) -> list[Any]:
    value = json.loads(text)
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError("JSON document must be an array")
    return list(value)
