from __future__ import annotations

import codecs
from pathlib import Path


class LocalSidecarLyricsReader:
    def read(self, source: Path) -> str | None:
        for suffix in (".txt", ".lrc"):
            candidate = source.with_suffix(suffix)
            if candidate.is_file():
                data = candidate.read_bytes()
                encoding = (
                    "utf-16"
                    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE))
                    and not data.startswith(codecs.BOM_UTF32_LE)
                    else "utf-8-sig"
                )
                text = data.decode(encoding).replace("\r\n", "\n").replace("\r", "\n").strip()
                if text:
                    return text
        return None
