# MIT License
# Copyright (c) 2023 Sangeon Yong
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Inference architecture from seyong92/phoneme-informed-note-level-singing-transcription.

The published checkpoint uses the same features in its pitch and phoneme branches.
Calculate them once, keeping the original parameter names for strict checkpoint loading.
"""

from __future__ import annotations

import torch
from torch import nn
from torchaudio.transforms import AmplitudeToDB
from nnAudio.features import MelSpectrogram


class _Features(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.feat = MelSpectrogram(
            sr=16000,
            n_fft=1024,
            win_length=1024,
            n_mels=80,
            hop_length=320,
            fmin=0,
            fmax=8000,
            center=True,
            verbose=False,
        )
        self.db = AmplitudeToDB(stype="power", top_db=80)

    def forward(self, audio: torch.Tensor) -> torch.Tensor:
        result: torch.Tensor = self.db(self.feat(audio))
        return result


class _ConvStack(nn.Module):
    def __init__(self, features: int, size: int, dilation: int = 1) -> None:
        super().__init__()
        self.cnn = nn.Sequential(
            nn.Conv2d(1, size // 16, (3, 3), padding=(dilation, 1), dilation=(dilation, 1)),
            nn.BatchNorm2d(size // 16),
            nn.ReLU(),
            nn.Conv2d(size // 16, size // 16, (3, 3), padding=1),
            nn.BatchNorm2d(size // 16),
            nn.ReLU(),
            nn.MaxPool2d((1, 2)),
            nn.Dropout(0.25),
            nn.Conv2d(size // 16, size // 8, (3, 3), padding=1),
            nn.BatchNorm2d(size // 8),
            nn.ReLU(),
            nn.MaxPool2d((1, 2)),
            nn.Dropout(0.25),
        )
        self.fc = nn.Sequential(nn.Linear((size // 8) * (features // 4), size), nn.Dropout(0.5))

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        result: torch.Tensor = self.fc(self.cnn(features).transpose(1, 2).flatten(-2))
        return result


class _Recurrent(nn.Module):
    def __init__(self, features: int, size: int) -> None:
        super().__init__()
        self.rnn = nn.LSTM(features, size // 2, batch_first=True, bidirectional=True)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        batch, frames, _ = features.shape
        hidden = self.rnn.hidden_size
        output = features.new_zeros(batch, frames, 2 * hidden)
        offsets = range(0, frames, 512)
        for starts, first in ((offsets, 0), (reversed(offsets), hidden)):
            h = features.new_zeros(2, batch, hidden)
            c = torch.zeros_like(h)
            for start in starts:
                result, (h, c) = self.rnn(features[:, start : start + 512], (h, c))
                output[:, start : start + 512, first:] = result[:, :, first:]
        return output


class _LanguageModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.feat_ext = _Features()
        self.conv_stack = _ConvStack(80, 1024)
        self.rnn = _Recurrent(1024, 1024)
        self.fc = nn.Linear(1024, 39)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        result: torch.Tensor = self.fc(self.rnn(self.conv_stack(features)))
        return result


class PhonemeNoteModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.pitch_feat_ext = _Features()
        self.lang_model = _LanguageModel()
        self.pitch_conv_stack = _ConvStack(80, 768, 2)
        self.lang_conv_stack = _ConvStack(38, 768, 2)
        self.pitch_rnn = _Recurrent(768, 768)
        self.lang_rnn = _Recurrent(768, 768)
        self.combined_rnn = _Recurrent(1536, 768)
        self.combined_fc = nn.Linear(768, 3)

    def forward(self, audio: torch.Tensor) -> torch.Tensor:
        features = self.pitch_feat_ext(audio).transpose(1, 2).unsqueeze(1)
        language = self.lang_model(features).unsqueeze(1)
        pitch = self.pitch_rnn(self.pitch_conv_stack(features))
        language = self.lang_rnn(self.lang_conv_stack(language))
        result: torch.Tensor = self.combined_fc(
            self.combined_rnn(torch.cat([pitch, language], dim=2))
        )
        return result
