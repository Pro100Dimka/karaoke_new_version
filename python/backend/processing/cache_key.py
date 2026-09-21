from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True, slots=True)
class CacheIdentity:
    input_identity: str
    model_id: str
    model_version: str
    algorithm_version: str
    parameters: Mapping[str, str | int | float | bool]


def build_cache_key(identity: CacheIdentity) -> str:
    parts = [
        identity.input_identity,
        identity.model_id,
        identity.model_version,
        identity.algorithm_version,
    ]
    parts.extend(f"{key}={identity.parameters[key]}" for key in sorted(identity.parameters))
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()
