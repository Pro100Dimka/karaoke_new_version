from __future__ import annotations

import pytest
import sys
import threading
from pathlib import Path

from backend.ai.domain import AiCapability, AiProviderDescriptor
from backend.infrastructure.command_ai_provider import CommandAiProvider
from backend.infrastructure.process_runner import ProcessRunner
from backend.songs.domain import Language
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from tests.conftest import write_wav


pytestmark = pytest.mark.integration


def _provider_script(path: Path, execution: ExecutionContext) -> None:
    path.write_text(
        f"import os\nassert os.environ['AD_VOICE_COMPUTE_DEVICE'] == {execution.device.value.lower()!r}\n"
        f"assert all(os.environ[key] == '{execution.cpu_threads}' for key in "
        "('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'))\n"
        + """
import json
import pathlib
import shutil
import sys


def option(name):
    index = sys.argv.index(name)
    return sys.argv[index + 1]


action = sys.argv[1]
if action == "separate":
    source = pathlib.Path(option("--input"))
    output = pathlib.Path(option("--output"))
    output.mkdir(parents=True, exist_ok=True)
    instrumental = output / "instrumental.wav"
    vocal = output / "reference-vocal.wav"
    shutil.copy2(source, instrumental)
    shutil.copy2(source, vocal)
    payload = {"instrumental": str(instrumental), "referenceVocal": str(vocal)}
elif action == "transcribe":
    payload = {"text": "hello"}
elif action == "align":
    payload = {"words": [{"text": option("--lyrics"), "start": 0.1, "end": 0.8, "confidence": 0.9}]}
elif action == "pitch":
    payload = {"points": [{"time": 0.2, "frequency": 440.0, "confidence": 0.95}]}
else:
    raise SystemExit(2)
print(json.dumps(payload))
""".strip(),
        encoding="utf-8",
    )


@pytest.mark.parametrize("device", list(ComputeDevice))
def test_command_ai_provider_satisfies_provider_contract(
    tmp_path: Path, device: ComputeDevice
) -> None:
    script = tmp_path / "provider.py"
    execution = ExecutionContext(device, 3)
    _provider_script(script, execution)
    audio = tmp_path / "input.wav"
    write_wav(audio, seconds=0.1)
    descriptor = AiProviderDescriptor(
        provider_id="contract-provider",
        version="1.2.3",
        capabilities=frozenset(AiCapability),
        supported_languages=frozenset(language.value for language in Language),
        required_models=(),
        required_resources={"cpuThreads": 1},
    )
    provider = CommandAiProvider(
        descriptor,
        [sys.executable, str(script)],
        ProcessRunner(),
        timeout_seconds=5,
    )
    cancel = threading.Event()

    separated = provider.separate(audio, tmp_path / "work", cancel, execution=execution)
    transcription = provider.transcribe(audio, Language.ENGLISH, cancel, execution=execution)
    words = provider.align(audio, "hello", Language.ENGLISH, cancel, execution=execution)
    points = provider.pitch(audio, cancel, execution=execution)

    assert provider.descriptor == descriptor
    assert separated.instrumental.is_file()
    assert separated.reference_vocal.is_file()
    assert transcription == "hello"
    assert words[0].text == "hello"
    assert 0 <= words[0].start < words[0].end
    assert points[0].frequency == 440.0
