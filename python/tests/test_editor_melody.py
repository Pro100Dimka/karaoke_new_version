from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.processing.melody_reference import RenderMelodyReference
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.test_editor_revisions import ready_song

pytestmark = pytest.mark.integration


def _artifacts(root: Path, song_id: str, revision: int) -> dict[str, Path]:
    folder = root / "songs" / song_id / "revisions" / str(revision)
    manifest = json.loads((folder / "manifest.json").read_text())
    return {item["logicalName"]: folder / item["relativePath"] for item in manifest["artifacts"]}


def _frequency(path: Path) -> float:
    audio, rate = sf.read(path, always_2d=True)
    signal = audio[int(0.2 * rate) : int(0.7 * rate)].mean(axis=1)
    spectrum = np.abs(np.fft.rfft(signal * np.hanning(len(signal))))
    return float(np.fft.rfftfreq(len(signal), 1 / rate)[np.argmax(spectrum)])


def test_saved_note_and_reset_update_the_published_audible_guide(tmp_path: Path) -> None:
    source, root = tmp_path / "song.wav", tmp_path / "runtime"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        song_id = str(song["songId"])
        endpoint = f"/songs/{song_id}/editor"
        before = client.get(endpoint).json()
        original = _artifacts(root, song_id, before["revision"])
        original_audio = original["melody"].read_bytes()
        document = before["document"]
        document["words"][0]["notes"][0]["note"] = 81
        saved = client.put(
            endpoint, json={"expectedRevision": before["revision"], "document": document}
        )
        assert saved.status_code == 200, saved.text
        reopened = client.get(endpoint).json()
        updated = _artifacts(root, song_id, reopened["revision"])
        assert reopened["document"]["words"][0]["notes"][0]["note"] == 81
        assert abs(_frequency(updated["melody"]) - 880) < 3
        assert abs(_frequency(original["melody"]) - 440) < 3
        assert original["melody"].read_bytes() == original_audio
        assert not original["melody"].samefile(updated["melody"])
        assert sf.info(updated["melody"]).frames == sf.info(original["melody"]).frames
        assert sf.info(updated["melody"]).samplerate == 44100
        assert sf.info(updated["melody"]).channels == 2
        for name in ("instrumental", "referenceVocal", "lyricsBaseline"):
            assert original[name].samefile(updated[name])
        reset = client.post(f"{endpoint}/reset", json={"expectedRevision": reopened["revision"]})
        assert reset.status_code == 200, reset.text
        restored = _artifacts(root, song_id, reset.json()["revision"])
        assert abs(_frequency(restored["melody"]) - 440) < 3
        assert abs(_frequency(updated["melody"]) - 880) < 3


def test_deleting_all_notes_saves_a_silent_guide(tmp_path: Path) -> None:
    source, root = tmp_path / "song.wav", tmp_path / "runtime"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        endpoint = f"/songs/{song['songId']}/editor"
        before = client.get(endpoint).json()
        for word in before["document"]["words"]:
            word["notes"] = []
        saved = client.put(
            endpoint, json={"expectedRevision": before["revision"], "document": before["document"]}
        )
        assert saved.status_code == 200, saved.text
        artifacts = _artifacts(root, str(song["songId"]), saved.json()["revision"])
        audio, rate = sf.read(artifacts["melody"], always_2d=True)
        assert rate == 44100 and len(audio) == 44100
        assert np.count_nonzero(audio) == 0


def test_text_only_save_keeps_shared_audio_without_rendering(tmp_path: Path, monkeypatch) -> None:
    source, root = tmp_path / "song.wav", tmp_path / "runtime"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        endpoint = f"/songs/{song['songId']}/editor"
        before = client.get(endpoint).json()
        artifacts = _artifacts(root, str(song["songId"]), before["revision"])

        def forbidden(*args):
            raise AssertionError("Text-only editor save must not regenerate audio")

        monkeypatch.setattr(RenderMelodyReference, "run", forbidden)
        before["document"]["title"] = "Corrected title"
        saved = client.put(
            endpoint, json={"expectedRevision": before["revision"], "document": before["document"]}
        )
        assert saved.status_code == 200, saved.text
        updated = _artifacts(root, str(song["songId"]), saved.json()["revision"])
        for name in ("instrumental", "referenceVocal", "melody"):
            assert artifacts[name].samefile(updated[name])


def test_failed_guide_render_preserves_active_revision_and_removes_staging(
    tmp_path: Path, monkeypatch
) -> None:
    source, root = tmp_path / "song.wav", tmp_path / "runtime"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        song_id = str(song["songId"])
        endpoint = f"/songs/{song_id}/editor"
        before = client.get(endpoint).json()
        melody = _artifacts(root, song_id, before["revision"])["melody"]
        original_audio = melody.read_bytes()
        temporary: list[Path] = []

        def fail(_self, _document, workspace):
            temporary.append(workspace)
            (workspace / "partial.wav").write_bytes(b"unfinished")
            raise RuntimeError("renderer failed")

        monkeypatch.setattr(RenderMelodyReference, "run", fail)
        before["document"]["words"][0]["notes"][0]["note"] = 81
        with pytest.raises(RuntimeError, match="renderer failed"):
            client.put(
                endpoint,
                json={"expectedRevision": before["revision"], "document": before["document"]},
            )
        reopened = client.get(endpoint).json()
        assert reopened["revision"] == before["revision"]
        assert reopened["document"]["words"][0]["notes"][0]["note"] == 69
        assert melody.read_bytes() == original_audio
        assert temporary and not temporary[0].exists()
        assert not (temporary[0].parent / f"project-{song_id}-{before['revision'] + 1}").exists()
