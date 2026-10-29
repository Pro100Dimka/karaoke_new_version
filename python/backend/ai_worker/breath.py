"""Conservative breath-like event detection and local attenuation.

Respiro-en inference architecture/frontend adapted from DongYANG's implementation:
https://github.com/ydqmkkx/Respiro-en/tree/70e01c60c2f582c41092730680f2894ab24d6467

MIT License
Copyright (c) 2024 DongYANG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import math
import hashlib
from pathlib import Path
from types import MappingProxyType

import librosa
import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from torchaudio.models import Conformer

from backend.ai_worker.timing import _runs
from backend.serialization import JsonValue

PARAMETERS: MappingProxyType[str, JsonValue] = MappingProxyType(
    {
        "confidence": 0.99,
        "candidateConfidence": 0.9,
        "minimumSeconds": 0.08,
        "maximumSeconds": 1.2,
        "minimumGain": 0.5,
        "fadeSeconds": 0.02,
        "contextSeconds": 2,
        "chunkSeconds": 10,
        "voiceProtection": "any-channel-positive-vad-or-harmonic-evidence",
    }
)


class _Downsampling(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.conv1 = nn.Sequential(nn.Conv2d(3, 1, kernel_size=3, stride=2), nn.ReLU())
        self.conv2 = nn.Sequential(nn.Conv2d(1, 1, kernel_size=3, stride=2), nn.ReLU())

    def forward(self, x: torch.Tensor, length: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        for convolution in (self.conv1, self.conv2):
            padding = 1 - x.shape[-1] % 2
            x = convolution(F.pad(x, (0, padding, 0, 0)))
            length = (length - 3 + padding) // 2 + 1
        return x, length


class _Upsampling(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.deconv = nn.Sequential(
            nn.ConvTranspose1d(128, 128, kernel_size=3, stride=2),
            nn.ReLU(),
            nn.ConvTranspose1d(128, 128, kernel_size=3, stride=2),
            nn.ReLU(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        result: torch.Tensor = self.deconv(x)
        return result


class _BreathDetector(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.downsampling = _Downsampling()
        self.upsampling = _Upsampling()
        self.linear = nn.Linear(31, 128)
        self.dropout = nn.Dropout(0.1)
        self.conformer = Conformer(
            input_dim=128,
            num_heads=4,
            ffn_dim=256,
            num_layers=8,
            depthwise_conv_kernel_size=31,
            dropout=0.1,
        )
        self.lstm = nn.LSTM(128, 256, bidirectional=True, batch_first=True)
        self.fc = nn.Linear(512, 1)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x: torch.Tensor, length: torch.Tensor) -> torch.Tensor:
        sequence = x.shape[-1]
        x, length = self.downsampling(x, length)
        x = self.dropout(self.linear(x.squeeze(1).transpose(1, 2).contiguous()))
        x = self.conformer(x, length)[0].transpose(1, 2).contiguous()
        x = self.upsampling(x).transpose(1, 2).contiguous()
        x = self.lstm(x)[0]
        result: torch.Tensor = self.sigmoid(self.fc(x).squeeze(-1))
        return result[:, :sequence]


def _features(samples: np.ndarray) -> tuple[torch.Tensor, torch.Tensor]:
    power = librosa.feature.melspectrogram(
        y=samples, sr=16000, n_fft=400, hop_length=160, n_mels=128
    )
    mel = torch.from_numpy(librosa.power_to_db(power, ref=np.max))[None]
    frames = librosa.util.frame(np.pad(samples, (200, 200)), frame_length=400, hop_length=160)
    zcr = np.abs(np.diff(np.sign(frames), axis=0)).sum(axis=0) * 0.5 / 400
    crossings = torch.from_numpy(zcr)[None, None].expand(-1, 128, -1)
    variance = mel.var(dim=1)[:, None].expand(-1, 128, -1)
    return torch.stack((mel, variance, crossings), dim=1), torch.tensor([mel.shape[-1]])


def detect_breath_events(
    audio: np.ndarray, rate: int, weights: Path, target: str
) -> tuple[np.ndarray, list[JsonValue]]:
    """Independent per-channel scores, with bounded attention memory and native-time origins."""
    count = 1 + math.ceil(audio.shape[1] * 16000 / rate) // 160
    probabilities = np.zeros((len(audio), count), dtype=np.float32)
    inputs: list[JsonValue] = []
    if audio.shape[1] < rate:
        return probabilities, inputs
    model = _BreathDetector().eval().to(target)
    model.load_state_dict(
        torch.load(weights, map_location="cpu", weights_only=True)["model"], strict=True
    )
    with torch.inference_mode():
        for channel, raw in enumerate(audio):
            samples = librosa.resample(raw, orig_sr=rate, target_sr=16000)
            inputs.append(
                {
                    "channel": channel,
                    "sampleRate": 16000,
                    "samples": len(samples),
                    "pcmSha256": hashlib.sha256(samples.tobytes()).hexdigest(),
                }
            )
            for first in range(0, count, 1000):
                last = min(count, first + 1000)
                begin, end = max(0, first - 200), min(count, last + 200)
                features, length = _features(samples[begin * 160 : end * 160])
                prediction = model(features.to(target), length.to(target))[0].cpu().numpy()
                probabilities[channel, first:last] = prediction[first - begin : last - begin]
    return probabilities, inputs


def attenuate_breath_events(
    audio: np.ndarray, probabilities: np.ndarray, protected: np.ndarray, rate: int
) -> tuple[np.ndarray, dict[str, JsonValue]]:
    """A positive breath prediction is required; absent pitch/CTC never suffices."""
    if audio.ndim != 2 or rate < 8000 or not np.issubdtype(audio.dtype, np.floating):
        raise ValueError("Breath attenuation requires channel-first floating-point audio")
    count = 1 + math.ceil(audio.shape[1] * 16000 / rate) // 160
    if probabilities.shape != (len(audio), count) or protected.shape != probabilities.shape:
        raise ValueError("Breath evidence must cover every channel on the 10-ms timeline")
    if not all(np.isfinite(item).all() for item in (audio, probabilities, protected)):
        raise ValueError("Breath attenuation requires finite audio and evidence")
    if np.any((probabilities < 0) | (probabilities > 1)):
        raise ValueError("Invalid breath probabilities")
    result = audio.copy()
    events: list[JsonValue] = []
    veto = np.any(protected > 0, axis=0)
    for channel, probability in enumerate(probabilities):
        events.extend(
            {"channel": channel, **event}
            for event in _channel_events(result[channel], probability, veto, rate)
        )
    return result, {
        "parameters": PARAMETERS.copy(),
        "events": events,
        "decision": "attenuated" if not np.array_equal(result, audio) else "unchanged",
    }


def _channel_events(
    audio: np.ndarray, probability: np.ndarray, veto: np.ndarray, rate: int
) -> list[dict[str, JsonValue]]:
    events: list[dict[str, JsonValue]] = []
    for start, end in _runs(probability > 0.9, True):
        eligible = (probability[start:end] > 0.99) & ~veto[start:end]
        intervals = [(a + start, b + start) for a, b in _runs(eligible, True) if b - a >= 8]
        duration = 8 <= end - start <= 120
        if duration:
            events.extend(_duck(audio, a, b, rate) for a, b in intervals)
        decision = next(
            name
            for name, active in (
                ("unchanged:event-duration", not duration),
                ("attenuated:confident-interior", bool(intervals)),
                ("unchanged:voice-protected", bool(veto[start:end].any())),
                ("unchanged:uncertain-boundary", True),
            )
            if active
        )
        events.append(
            {
                "start": start / 100,
                "end": end / 100,
                "decision": decision,
                "probability": float(probability[start:end].mean()),
                "protectedFraction": float(veto[start:end].mean()),
            }
        )
    return events


def _duck(audio: np.ndarray, start: int, end: int, rate: int) -> dict[str, JsonValue]:
    first, last = round(start * rate / 100), min(len(audio), round(end * rate / 100))
    gain = np.full(last - first, 0.5, dtype=audio.dtype)
    fade = min(round(0.02 * rate), len(gain) // 2)
    ramp = (0.75 + 0.25 * np.cos(np.linspace(0, np.pi, fade))).astype(audio.dtype)
    gain[:fade], gain[-fade:] = ramp, ramp[::-1]
    audio[first:last] *= gain
    return {
        "start": first / rate,
        "end": last / rate,
        "minimumGain": 0.5,
        "decision": "attenuated:breath-like-event",
        "preservation": "outside-positive-voice-guard",
    }
