from __future__ import annotations

import unicodedata


def normalize_search(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()
