from __future__ import annotations

from backend.serialization import JsonValue, dumps, loads_object
from backend.lyrics.domain import LyricsDocument, Note, Word


def encode_document(document: LyricsDocument) -> str:
    document.validate()
    return dumps(
        {
            "title": document.title,
            "artist": document.artist,
            "duration": document.duration,
            "bpm": document.bpm,
            "key": document.key,
            "lyrics": document.lyrics,
            "words": [
                {
                    "text": word.text,
                    "start": word.start,
                    "end": word.end,
                    "notes": [
                        {"note": note.note, "start": note.start, "end": note.end}
                        for note in word.notes
                    ],
                }
                for word in document.words
            ],
        }
    )


def decode_document(raw: str) -> LyricsDocument:
    data = loads_object(raw)
    words_raw = data.get("words")
    if not isinstance(words_raw, list):
        raise ValueError("words must be an array")
    document = LyricsDocument(
        title=_text(data, "title"),
        artist=_text(data, "artist"),
        duration=_number(data, "duration"),
        bpm=_optional_number(data.get("bpm")),
        key=_optional_text(data.get("key")),
        lyrics=_text(data, "lyrics", allow_empty=True),
        words=tuple(_word(item) for item in words_raw),
    )
    document.validate()
    return document


def _word(value: JsonValue) -> Word:
    if not isinstance(value, dict):
        raise ValueError("word must be an object")
    notes_raw = value.get("notes")
    if not isinstance(notes_raw, list):
        raise ValueError("notes must be an array")
    return Word(
        text=_text(value, "text"),
        start=_number(value, "start"),
        end=_number(value, "end"),
        notes=tuple(_note(item) for item in notes_raw),
    )


def _note(value: JsonValue) -> Note:
    if not isinstance(value, dict):
        raise ValueError("note must be an object")
    note_value = value.get("note")
    if not isinstance(note_value, int):
        raise ValueError("note must be an integer")
    return Note(note_value, _number(value, "start"), _number(value, "end"))


def _text(data: dict[str, JsonValue], key: str, *, allow_empty: bool = False) -> str:
    value = data.get(key)
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ValueError(f"{key} must be text")
    return value


def _number(data: dict[str, JsonValue], key: str) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{key} must be numeric")
    return float(value)


def _optional_number(value: JsonValue) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError("optional numeric value is invalid")
    return float(value)


def _optional_text(value: JsonValue) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("optional text value is invalid")
    return value
