from __future__ import annotations

import re
import unicodedata


def normalize_search(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def strip_annotations(value: str) -> str:
    """Drops bracketed parts such as "(zaycev.net)" or "[Live]" and collapses the whitespace that remains."""
    return " ".join(re.sub(r"[\(\[].*?[\)\]]", " ", value).split())
