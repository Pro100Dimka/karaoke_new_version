from __future__ import annotations

import wave
from pathlib import Path

from backend.lyrics.domain import LyricsDocument, Note, Word
from backend.processing.melody_reference import RenderMelodyReference


def _document(words: list[Word], duration: float) -> LyricsDocument:
    return LyricsDocument("t", "a", duration, None, None, "la", words)


def test_renders_a_wav_spanning_the_documents_own_duration(tmp_path: Path) -> None:
    words = [Word("la", 0.0, 1.0, [Note(69, 0.1, 0.9)])]
    target = RenderMelodyReference().run(_document(words, 2.5), tmp_path)
    with wave.open(str(target), "rb") as audio:
        assert audio.getnchannels() == 2
        assert abs(audio.getnframes() / audio.getframerate() - 2.5) < 0.01


def test_stays_silent_outside_any_note_and_sounds_during_one(tmp_path: Path) -> None:
    words = [Word("la", 0.0, 1.0, [Note(69, 0.3, 0.7)])]
    target = RenderMelodyReference().run(_document(words, 1.0), tmp_path)
    with wave.open(str(target), "rb") as audio:
        rate = audio.getframerate()
        before = audio.readframes(int(0.1 * rate))
        audio.setpos(int(0.5 * rate))
        during = audio.readframes(int(0.05 * rate))
    assert max(before) == 0, "no sound before the note starts"
    assert max(during) > 0, "the synthesized tone sounds while the note is active"


def test_an_instrumental_document_with_no_notes_renders_pure_silence(tmp_path: Path) -> None:
    target = RenderMelodyReference().run(_document([], 1.0), tmp_path)
    with wave.open(str(target), "rb") as audio:
        samples = audio.readframes(audio.getnframes())
    assert max(samples) == 0
