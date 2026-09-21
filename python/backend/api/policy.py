from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ApiPolicy:
    default_page_limit: int = 50
    max_page_limit: int = 200
    max_upload_path_length: int = 4096
