from __future__ import annotations

from math import isfinite

from backend.serialization import JsonValue, dumps, loads_object
from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.lyrics.ports import LyricLineTiming


def decode_timing_hints(value: object, duration: float) -> tuple[LyricLineTiming, ...]:
    """Optional coarse phrase evidence; invalid legacy metadata supplies no hint."""
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(
        LyricLineTiming(float(start), text)
        for item in value
        if isinstance(item, dict)
        for start, text in [(item.get("start"), item.get("text"))]
        if isinstance(start, (int, float))
        and not isinstance(start, bool)
        and isfinite(start)
        and 0 <= start < duration
        and isinstance(text, str)
        and text.strip()
    )


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
            **({"rhythm": [list(point) for point in document.rhythm]} if document.rhythm else {}),
            **(
                {"vocalActivity": [list(interval) for interval in document.vocal_activity]}
                if document.vocal_activity
                else {}
            ),
            "words": [
                {
                    "text": word.text,
                    "start": word.start,
                    "end": word.end,
                    "letters": list(word.letters),
                    "notes": [
                        {
                            "note": note.note,
                            "start": note.start,
                            "end": note.end,
                            **(
                                {"contour": [list(point) for point in note.contour]}
                                if note.contour
                                else {}
                            ),
                        }
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
        vocal_activity=tuple(
            (point[0], point[1])
            for point in _numeric_points(data.get("vocalActivity", []), dimensions=2)
        ),
        rhythm=decode_rhythm(data.get("rhythm", [])),
    )
    document.validate()
    return document


def decode_rhythm(value: object) -> tuple[tuple[float, float], ...]:
    points = tuple((point[0], point[1]) for point in _numeric_points(value, dimensions=2))
    if any(not isfinite(at) or at < 0 or not 0 < strength <= 1 for at, strength in points):
        raise ValueError("Rhythm points must have finite times and strengths 0..1")
    if any(right[0] <= left[0] for left, right in zip(points, points[1:], strict=False)):
        raise ValueError("Rhythm points must be ordered")
    return points


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
        letters=_letters(value.get("letters")),
    )


def _letters(value: JsonValue) -> tuple[float, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or any(
        isinstance(item, bool) or not isinstance(item, int | float) for item in value
    ):
        raise ValueError("letters must be an array of numbers")
    return tuple(float(item) for item in value if isinstance(item, int | float))


def _note(value: JsonValue) -> Note:
    if not isinstance(value, dict):
        raise ValueError("note must be an object")
    note_value = value.get("note")
    if not isinstance(note_value, int):
        raise ValueError("note must be an integer")
    contour = _numeric_points(value.get("contour", []), dimensions=3)
    return Note(
        note_value,
        _number(value, "start"),
        _number(value, "end"),
        tuple((point[0], point[1], point[2]) for point in contour),
    )


def _numeric_points(value: object, *, dimensions: int) -> tuple[tuple[float, ...], ...]:
    if not isinstance(value, list):
        raise ValueError("expected an array of numeric points")
    result = []
    for point in value:
        if (
            not isinstance(point, list)
            or len(point) not in {2, dimensions}
            or any(isinstance(item, bool) or not isinstance(item, int | float) for item in point)
        ):
            raise ValueError("invalid numeric point")
        numbers = tuple(float(item) for item in point if isinstance(item, int | float))
        result.append(numbers + ((1.0,) if len(numbers) < dimensions else ()))
    return tuple(result)


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
