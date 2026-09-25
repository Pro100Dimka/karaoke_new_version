from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.request
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

# Run from the repository root. Kaggle supplies CUDA-enabled torch/torchaudio.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
DATA = Path("/kaggle/working/ad-voice-data")
SESSIONS = Path("/kaggle/working/ad-voice-sessions")
os.environ.update(
    AD_VOICE_DATA=str(DATA),
    AD_VOICE_MODELS=str(DATA / "models"),
    AD_VOICE_COMPUTE_DEVICE="cuda",
    OMP_NUM_THREADS=str(max(1, os.cpu_count() or 1)),
)

import gradio as gr
import soundfile as sf
import torch
from backend.ai.catalog import CATALOG
from backend.ai_worker.pitch import pitch
from backend.ai_worker.separation import separate
from backend.ai_worker.speech import (
    align,
    prepare_accelerator,
    transcribe,
)

TTL_SECONDS = 6 * 60 * 60
PROTOCOL_VERSION = 2
_lock = threading.Lock()
_pitch_workers = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ad-voice-pitch")
_pitch_jobs: dict[str, Future[dict]] = {}


def _download_models() -> None:
    for spec in CATALOG:
        target = DATA / "models" / spec.model_id / spec.version / "model.bin"
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file() and _sha256(target) == spec.checksum:
            continue
        partial = target.with_suffix(".partial")
        urllib.request.urlretrieve(spec.download_url, partial)
        if _sha256(partial) != spec.checksum:
            partial.unlink(missing_ok=True)
            raise RuntimeError(f"Checksum failed for {spec.model_id}")
        partial.replace(target)
    # Enables the exact accelerated guidance path used by the desktop backend.
    prepare_accelerator()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _cleanup() -> None:
    cutoff = time.time() - TTL_SECONDS
    with _lock:
        for directory in SESSIONS.glob("*"):
            if directory.is_dir() and directory.stat().st_mtime < cutoff:
                job = _pitch_jobs.pop(directory.name, None)
                if job is not None:
                    job.cancel()
                shutil.rmtree(directory, ignore_errors=True)


def _session(session_id: str) -> Path:
    if not session_id or any(character not in "0123456789abcdef" for character in session_id):
        raise gr.Error("Invalid session")
    directory = (SESSIONS / session_id).resolve()
    if directory.parent != SESSIONS.resolve() or not directory.is_dir():
        raise gr.Error("Session expired; process the song again")
    os.utime(directory, None)
    return directory


def separate_song(upload: str) -> tuple[str, str, str]:
    _cleanup()
    session_id = uuid.uuid4().hex
    directory = SESSIONS / session_id
    directory.mkdir(parents=True)
    source = directory / Path(upload).name
    shutil.copyfile(upload, source)
    result = separate(source, directory / "separation")
    vocal = Path(result["referenceVocal"])
    with _lock:
        # Pitch extraction only reads the vocal. Start it while lossless stems are
        # compressed and transferred so this GPU stage is off the critical path.
        _pitch_jobs[session_id] = _pitch_workers.submit(pitch, vocal)
    return (
        _compress_stem(Path(result["instrumental"])),
        _compress_stem(vocal),
        session_id,
    )


def _compress_stem(source: Path) -> str:
    """Use lossless FLAC over the public tunnel, keeping PCM WAV inside the project."""
    destination = source.with_suffix(".flac")
    samples, sample_rate = sf.read(source, dtype="int16", always_2d=True)
    sf.write(destination, samples, sample_rate, format="FLAC", subtype="PCM_16")
    return str(destination)


def transcribe_song(session_id: str, language: str) -> str:
    vocal = _session(session_id) / "separation" / "vocals.wav"
    return transcribe(vocal, language)["text"]


def align_song(session_id: str, lyrics: str, language: str, timing_hints: str) -> dict:
    vocal = _session(session_id) / "separation" / "vocals.wav"
    hints = json.loads(timing_hints) if timing_hints else []
    return align(vocal, lyrics, language, hints)


def pitch_song(session_id: str) -> dict:
    vocal = _session(session_id) / "separation" / "vocals.wav"
    with _lock:
        job = _pitch_jobs.get(session_id)
    if job is not None:
        return job.result()
    return pitch(vocal)


def health() -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "cuda": torch.cuda.is_available(),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
    }


def main() -> None:
    if not torch.cuda.is_available():
        raise RuntimeError("Enable a GPU accelerator in Kaggle Notebook settings")
    token = os.environ.get("AD_VOICE_TOKEN", "")
    if len(token) < 8:
        raise RuntimeError("Create a Kaggle secret named AD_VOICE_TOKEN (at least 8 characters)")
    SESSIONS.mkdir(parents=True, exist_ok=True)
    _download_models()
    with gr.Blocks(title="A&D Voice Kaggle GPU") as app:
        gr.Markdown("# A&D Voice GPU\nKeep this cell running while the desktop app processes songs.")
        gr.Markdown(f"CUDA ready: **{torch.cuda.get_device_name(0)}**")
        with gr.Row(visible=False):
            upload = gr.File(type="filepath")
            instrumental = gr.File()
            vocal = gr.File()
            session_id = gr.Textbox()
            language = gr.Textbox()
            lyrics = gr.Textbox()
            hints = gr.Textbox()
            json_output = gr.JSON()
        gr.Button(visible=False).click(
            health,
            None,
            json_output,
            api_name="health",
            concurrency_limit=4,
        )
        gr.Button(visible=False).click(
            separate_song,
            upload,
            [instrumental, vocal, session_id],
            api_name="separate",
            concurrency_limit=1,
        )
        gr.Button(visible=False).click(
            transcribe_song,
            [session_id, language],
            lyrics,
            api_name="transcribe",
            concurrency_limit=1,
        )
        gr.Button(visible=False).click(
            align_song,
            [session_id, lyrics, language, hints],
            json_output,
            api_name="align",
            concurrency_limit=1,
        )
        gr.Button(visible=False).click(
            pitch_song,
            session_id,
            json_output,
            api_name="pitch",
            concurrency_limit=1,
        )
    app.queue(default_concurrency_limit=2).launch(
        share=True,
        auth=("advoice", token),
        show_error=True,
        allowed_paths=[str(SESSIONS)],
    )


if __name__ == "__main__":
    main()
