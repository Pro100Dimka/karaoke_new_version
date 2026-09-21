from __future__ import annotations

from pathlib import Path


class LocalSidecarLyricsReader:
    def read(self, source: Path) -> str | None:
        for suffix in (".txt", ".lrc"):
            candidate = source.with_suffix(suffix)
            if candidate.is_file():
                text = candidate.read_text(encoding="utf-8").strip()
                if text:
                    return text
        return None
