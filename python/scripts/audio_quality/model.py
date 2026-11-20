"""Pinned local Audiobox loader; optional ML packages are imported only on use."""

from __future__ import annotations

from dataclasses import dataclass
import importlib
import json
import os
from pathlib import Path
import sys
from typing import Any

import numpy as np

from scripts.audio_quality.contracts import AudioArray, checked_sha256

AXES = ("CE", "CU", "PC", "PQ")
CODE_REVISION = "2618e9d451b456e9328b39495b5e6234678aa550"
MODEL_REVISION = "9b1dd8e5df9af7216e836a98974fe3b82c56ded6"
WEIGHTS_SHA256 = "a5a3c2412649cc2384ec525ffd5180ce6c4778f43bed6108e0a1303de04d014e"
CONFIG_SHA256 = "0b8eabc5ced92cefed116a3aca8f1e59d2a33dc4d376b9e86dfb9c072e1d280d"
SOURCE_SHA256 = {
    "__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "cli.py": "218967b1634411f8f8fc8c06cc9c5d76b56c7ddd960a9ef5b023416e590ac433",
    "infer.py": "0dd81c8952f0fdb9c706da5cae0b75b859e26720a6c08034dcfb23244f8c9733",
    "utils.py": "c69c8c033518ae1274707aa055c8768ec2088b4a9604e8b513f039acaeb6e035",
    "model/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "model/aes.py": "2f339d5d2526ccee45f1daf7722d2b9d36bd9c99212134be12439057d1196238",
    "model/utils.py": "6af4d2acb03b9dad5ee34698f2ce96d423d4adb6bbdc6f3c591015c4da22ff3b",
    "model/wavlm.py": "ed010d90278d5a8414049041a0c8ff60826fbd53045f32f0551c66dee8cac29f",
}


@dataclass(frozen=True)
class ModelAssets:
    source_dir: Path
    model_dir: Path
    hashes: dict[Path, str]

    def provenance(self) -> dict[str, object]:
        return {
            "codeRepository": "https://github.com/facebookresearch/audiobox-aesthetics",
            "codeRevision": CODE_REVISION,
            "modelRevision": MODEL_REVISION,
            "modelUrl": "https://huggingface.co/facebook/audiobox-aesthetics/resolve/"
            + MODEL_REVISION
            + "/model.safetensors",
            "weightsSha256": WEIGHTS_SHA256,
            "configSha256": CONFIG_SHA256,
            "verifiedFiles": {str(path): digest for path, digest in self.hashes.items()},
            "license": "CC-BY-4.0; WavLM portions under MIT",
            "device": "cpu",
            "batchSize": 1,
            "inputRate": 16000,
            "inputChannels": 1,
        }


def verify_artifacts(source_dir: Path, model_dir: Path) -> ModelAssets:
    source_dir, model_dir = source_dir.resolve(), model_dir.resolve()
    hashes = {
        model_dir / "model.safetensors": WEIGHTS_SHA256,
        model_dir / "config.json": CONFIG_SHA256,
    }
    package = source_dir / "src/audiobox_aesthetics"
    hashes.update({package / name: digest for name, digest in SOURCE_SHA256.items()})
    for path, expected in hashes.items():
        checked_sha256(path, expected)
    present = {path.relative_to(package).as_posix() for path in package.rglob("*.py")}
    if present != set(SOURCE_SHA256):
        raise ValueError("Official source snapshot contains unexpected Python modules")
    return ModelAssets(source_dir, model_dir, hashes)


def verify_artifacts_unchanged(assets: ModelAssets) -> None:
    for path, expected in assets.hashes.items():
        checked_sha256(path, expected)


def _official_model_module(source_dir: Path) -> Any:
    prefix = "audiobox_aesthetics"
    for name, module in tuple(sys.modules.items()):
        if name == prefix or name.startswith(prefix + "."):
            location = getattr(module, "__file__", None)
            if not location or not Path(location).resolve().is_relative_to(source_dir):
                raise ValueError("A different Audiobox package is already imported")
    sys.path.insert(0, str(source_dir / "src"))
    module = importlib.import_module("audiobox_aesthetics.model.aes")
    if Path(module.__file__ or "").resolve() != source_dir / "src/audiobox_aesthetics/model/aes.py":
        raise ValueError("Audiobox import did not resolve to the verified source")
    return module


class LocalPredictor:
    def __init__(self, assets: ModelAssets, threads: int = 2) -> None:
        if threads < 1:
            raise ValueError("threads must be positive")
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        self.torch = importlib.import_module("torch")
        self.audio = importlib.import_module("torchaudio")
        tensors = importlib.import_module("safetensors.torch")
        official = _official_model_module(assets.source_dir)
        if tuple(official.AXES_NAME) != AXES:
            raise ValueError("Official Audiobox axes differ from the pinned contract")
        self.torch.set_num_threads(threads)
        self.config = json.loads((assets.model_dir / "config.json").read_text(encoding="utf-8"))
        self.model = official.AesMultiOutput(**self.config)
        state = tensors.load_file(str(assets.model_dir / "model.safetensors"), device="cpu")
        self.model.load_state_dict(state, strict=True)
        self.model.eval()
        self.provenance = assets.provenance() | {
            "threads": threads,
            "torchVersion": self.torch.__version__,
            "torchaudioVersion": self.audio.__version__,
            "numpyVersion": np.__version__,
        }

    def _batch(self, samples: AudioArray, rate: int) -> dict[str, Any]:
        if rate < 1 or samples.ndim != 2 or not 1 <= len(samples) <= rate * 10:
            raise ValueError("Pass one nonempty audio window of at most 10 seconds")
        if not np.isfinite(samples).all():
            raise ValueError("Audiobox input must be finite")
        wav = self.torch.from_numpy(np.asarray(samples.T, dtype=np.float32).copy())
        wav = self.audio.functional.resample(wav, orig_freq=rate, new_freq=16000)
        wav = wav.mean(dim=0, keepdim=True)
        length = wav.shape[-1]
        if not 1 <= length <= 160000:
            raise ValueError("Resampled window exceeds the official 10-second limit")
        waves = self.torch.nn.functional.pad(wav, (0, 160000 - length)).unsqueeze(0)
        mask = self.torch.zeros_like(waves, dtype=self.torch.bool)
        mask[..., :length] = True
        return {"wav": waves, "mask": mask}

    def score(self, samples: AudioArray, rate: int) -> dict[str, float]:
        with self.torch.inference_mode():
            output = self.model(self._batch(samples, rate))
        return {
            axis: float(output[axis][0]) * self.config["target_transform"][axis]["std"]
            + self.config["target_transform"][axis]["mean"]
            for axis in AXES
        }
