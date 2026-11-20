from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest
import soundfile as sf

from scripts.audio_quality.contracts import load_plan, read_window
from scripts.audio_quality.model import verify_artifacts
from scripts.audio_quality.runner import score_plan


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def _window_data() -> dict[str, object]:
    return {
        "id": "blind1",
        "sourceId": "s1",
        "recordingId": "r1",
        "windowId": "w1",
        "startFrame": 400,
        "frameCount": 800,
        "endFrameExclusive": 1200,
        "linearGain": 0.5,
        "gainDb": 20 * np.log10(0.5),
    }


def _fixture(tmp_path: Path) -> tuple[Path, Path, Path]:
    source = tmp_path / "source.wav"
    samples = np.arange(3200, dtype=np.float32).reshape(1600, 2) / 32000
    sf.write(source, samples, 8000, subtype="FLOAT")
    mapping = tmp_path / "mapping.json"
    _write_json(
        mapping,
        {
            "sourceConditions": {
                "s1": {
                    "path": str(source),
                    "sha256": _sha(source),
                    "frames": 1600,
                    "sampleRate": 8000,
                    "channels": 2,
                    "condition": "SECRET_CONDITION",
                }
            }
        },
    )
    manifest = tmp_path / "manifest.json"
    _write_json(
        manifest,
        {
            "count": 1,
            "sourceCount": 1,
            "sampleRate": 8000,
            "channels": 2,
            "commonTargetLufs": -18.0,
            "mappingSha256": _sha(mapping),
            "sourceSha256": {"s1": _sha(source)},
            "files": [_window_data()],
        },
    )
    return manifest, mapping, source


def _change_entry(manifest: Path, key: str, value: object) -> None:
    payload = json.loads(manifest.read_text())
    payload["files"][0][key] = value
    _write_json(manifest, payload)


class RecordingPredictor:
    def __init__(self) -> None:
        self.calls: list[tuple[np.ndarray, int]] = []

    def score(self, samples: np.ndarray, rate: int) -> dict[str, float]:
        self.calls.append((samples.copy(), rate))
        return {"CE": 1.0, "CU": 2.0, "PC": 3.0, "PQ": 4.0}


def test_exact_crop_and_constant_gain_are_scored_without_labels(tmp_path: Path) -> None:
    manifest, mapping, source = _fixture(tmp_path)
    plan = load_plan(manifest, mapping, _sha(manifest))
    predictor = RecordingPredictor()
    result = score_plan(plan, predictor, {"testPredictor": True})
    original, rate = sf.read(source, always_2d=True, dtype="float32")
    np.testing.assert_array_equal(predictor.calls[0][0], original[400:1200] * np.float32(0.5))
    np.testing.assert_array_equal(read_window(plan, plan.windows[0]), predictor.calls[0][0])
    assert predictor.calls[0][1] == rate
    assert "SECRET_CONDITION" not in repr(plan) + json.dumps(result)
    assert result["rows"][0]["scores"] == {"CE": 1.0, "CU": 2.0, "PC": 3.0, "PQ": 4.0}
    assert result["auditionedByAssistant"] is False
    assert result["conditionLabelsUsedForScoring"] is False
    assert result["allSourceHashesUnchanged"] is True
    assert len(result["limitations"]) >= 3


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("startFrame", -1),
        ("startFrame", 400.5),
        ("frameCount", 0),
        ("frameCount", 80001),
        ("frameCount", 1600),
        ("endFrameExclusive", 1199),
        ("linearGain", [0.5, 0.5]),
        ("linearGain", float("nan")),
        ("linearGain", float("inf")),
        ("linearGain", 0),
        ("linearGain", -1),
        ("gainDb", 0.0),
        ("sourceId", "missing"),
    ],
)
def test_invalid_window_or_gain_is_rejected(tmp_path: Path, key: str, value: object) -> None:
    manifest, mapping, _ = _fixture(tmp_path)
    _change_entry(manifest, key, value)
    with pytest.raises(ValueError):
        load_plan(manifest, mapping, _sha(manifest))


@pytest.mark.parametrize("changed", ["manifest", "mapping", "audio"])
def test_changed_frozen_content_is_rejected(tmp_path: Path, changed: str) -> None:
    manifest, mapping, source = _fixture(tmp_path)
    expected = _sha(manifest)
    path = {"manifest": manifest, "mapping": mapping, "audio": source}[changed]
    with path.open("ab") as handle:
        handle.write(b" ")
    with pytest.raises(ValueError, match="SHA256"):
        load_plan(manifest, mapping, expected)


@pytest.mark.parametrize(
    ("key", "value"), [("frames", 1599), ("sampleRate", 16000), ("channels", 1)]
)
def test_actual_audio_header_must_match_declaration(tmp_path: Path, key: str, value: int) -> None:
    manifest, mapping, _ = _fixture(tmp_path)
    data = json.loads(mapping.read_text())
    data["sourceConditions"]["s1"][key] = value
    _write_json(mapping, data)
    declared = json.loads(manifest.read_text())
    declared["mappingSha256"] = _sha(mapping)
    _write_json(manifest, declared)
    with pytest.raises(ValueError, match="format|frames"):
        load_plan(manifest, mapping, _sha(manifest))


def test_nonfinite_audio_is_rejected_even_with_matching_hashes(tmp_path: Path) -> None:
    manifest, mapping, source = _fixture(tmp_path)
    samples, rate = sf.read(source, always_2d=True)
    samples[500, 0] = np.nan
    sf.write(source, samples, rate, subtype="FLOAT")
    data = json.loads(mapping.read_text())
    data["sourceConditions"]["s1"]["sha256"] = _sha(source)
    _write_json(mapping, data)
    declared = json.loads(manifest.read_text())
    declared.update(mappingSha256=_sha(mapping), sourceSha256={"s1": _sha(source)})
    _write_json(manifest, declared)
    with pytest.raises(ValueError, match="finite"):
        load_plan(manifest, mapping, _sha(manifest))


def test_duplicate_ids_are_rejected(tmp_path: Path) -> None:
    manifest, mapping, _ = _fixture(tmp_path)
    data = json.loads(manifest.read_text())
    data["files"] *= 2
    data["count"] = 2
    _write_json(manifest, data)
    with pytest.raises(ValueError, match="Duplicate"):
        load_plan(manifest, mapping, _sha(manifest))


def test_source_hashes_are_checked_again_after_prediction(tmp_path: Path) -> None:
    manifest, mapping, source = _fixture(tmp_path)
    plan = load_plan(manifest, mapping, _sha(manifest))

    class MutatingPredictor(RecordingPredictor):
        def score(self, samples: np.ndarray, rate: int) -> dict[str, float]:
            with source.open("ab") as handle:
                handle.write(b"changed")
            return super().score(samples, rate)

    with pytest.raises(ValueError, match="SHA256"):
        score_plan(plan, MutatingPredictor(), {})


@pytest.mark.parametrize(
    "scores", [{"PQ": 4.0}, {"CE": 1.0, "CU": 2.0, "PC": 3.0, "PQ": float("nan")}]
)
def test_predictor_must_return_all_four_finite_axes(
    tmp_path: Path, scores: dict[str, float]
) -> None:
    manifest, mapping, _ = _fixture(tmp_path)
    plan = load_plan(manifest, mapping, _sha(manifest))

    class InvalidPredictor:
        def score(self, samples: np.ndarray, rate: int) -> dict[str, float]:
            return scores

    with pytest.raises(ValueError, match="axes|finite"):
        score_plan(plan, InvalidPredictor(), {})


def test_unpinned_weights_fail_before_optional_imports(tmp_path: Path) -> None:
    (tmp_path / "model.safetensors").write_bytes(b"wrong weights")
    with pytest.raises(ValueError, match="SHA256"):
        verify_artifacts(tmp_path / "official", tmp_path)


def test_validation_is_not_disabled_by_optimized_python(tmp_path: Path) -> None:
    manifest, mapping, _ = _fixture(tmp_path)
    _change_entry(manifest, "linearGain", 0)
    code = (
        "from pathlib import Path\n"
        "from scripts.audio_quality.contracts import load_plan\n"
        f"try: load_plan(Path({str(manifest)!r}), Path({str(mapping)!r}), {_sha(manifest)!r})\n"
        "except ValueError: print('rejected')\n"
        "else: raise SystemExit(9)\n"
    )
    run = subprocess.run([sys.executable, "-O", "-c", code], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert run.stdout.strip() == "rejected"


def test_cli_import_is_lazy_and_help_requires_no_model() -> None:
    code = (
        "import sys\nfrom scripts import audit_audio_quality\n"
        "print(any(name in sys.modules for name in ('torch', 'torchaudio', 'safetensors')))\n"
    )
    run = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert run.stdout.strip() == "False"
    help_run = subprocess.run(
        [sys.executable, "scripts/audit_audio_quality.py", "--help"],
        capture_output=True,
        text=True,
    )
    assert help_run.returncode == 0, help_run.stderr
    assert "--manifest-sha256" in help_run.stdout


@pytest.mark.parametrize("existing_output", [False, True])
def test_cli_validation_failure_never_writes_or_overwrites_output(
    tmp_path: Path, existing_output: bool
) -> None:
    from scripts.audit_audio_quality import main

    manifest, mapping, _ = _fixture(tmp_path)
    _change_entry(manifest, "linearGain", 0)
    original = manifest.read_bytes()
    output = manifest if existing_output else tmp_path / "result.json"
    code = main(
        [
            "--source-dir",
            str(tmp_path / "missing-source"),
            "--model-dir",
            str(tmp_path / "missing-model"),
            "--manifest",
            str(manifest),
            "--manifest-sha256",
            _sha(manifest),
            "--mapping",
            str(mapping),
            "--output",
            str(output),
        ]
    )
    assert code == 2
    assert manifest.read_bytes() == original
    assert output.exists() is existing_output
