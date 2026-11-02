"""Reproduce three measured word-boundary comparisons; no model inference."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import Normalize
from matplotlib.ticker import MultipleLocator, FormatStrFormatter
import numpy as np
import scipy
from scipy.signal import stft
from scipy.io import wavfile


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def signed_ms(value: float) -> str:
    return f"{round(value * 1000):+d}".replace("-", "−")


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", type=Path, default=Path("/tmp/karaoke-sync-v4"))
parser.add_argument("--output", type=Path)
args = parser.parse_args()
root = args.root.resolve()
output = args.output or root / "real-boundary-comparison.png"
reference_paths = [root / "audio-reference" / name for name in (
    "frozen-reference.json", "frozen-additional-reference.json")]
references = {}
for path in reference_paths:
    data = json.loads(path.read_text())
    references.update({case["case"]: (case, path) for case in data["cases"]})

selected = [("control_0003", 0, "Начало"),
            ("control_0000", 5, "Окончание"),
            ("breathy_0001", 5, "Окончание")]
colors = {"ref": "#3b4252", "v3": "#c56b13", "v4": "#007d87"}
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10.5,
                     "axes.titleweight": "bold", "axes.spines.top": False,
                     "axes.spines.right": False})
fig = plt.figure(figsize=(14, 11.4), facecolor="white")
outer = fig.add_gridspec(3, 2, width_ratios=[2.35, 1], left=.085, right=.972,
                        top=.882, bottom=.17, hspace=.43, wspace=.14)
rows = []
norm = Normalize(-65, 0)

for row_index, (case_id, word_index, focus) in enumerate(selected):
    case, reference_path = references[case_id]
    reference = case["words"][word_index]
    audio_path = Path(case["audioPath"])
    assert sha256(audio_path) == case["audioSha256"], audio_path
    sample_rate, pcm = wavfile.read(audio_path)
    assert pcm.dtype.kind == "i", "The selected source WAVs use signed PCM"
    waveform = pcm.astype(np.float64) / (np.iinfo(pcm.dtype).max + 1)
    assert waveform.ndim == 1 and sample_rate == case["sampleRate"]
    source_duration = len(waveform) / sample_rate
    payload_paths = {version: root / folder / case_id / "payload.json"
                     for version, folder in [("v3", "gtsinger-baseline"),
                                             ("v4", "gtsinger-final")]}
    values = {"ref": reference}
    for version, path in payload_paths.items():
        values[version] = json.loads(path.read_text())["words"][word_index]
        assert values[version]["text"] == reference["text"]

    left = max(0, min(word["start"] for word in values.values()) - .25)
    right = min(source_duration, max(word["end"] for word in values.values()) + .25)
    first, last = int(left * sample_rate), int(np.ceil(right * sample_rate))
    crop = waveform[first:last]
    frame, hop = round(sample_rate * .04), round(sample_rate * .005)
    frequencies, times, spectrum = stft(crop, sample_rate, window="hann", nperseg=frame,
                                        noverlap=frame - hop, boundary=None, padded=False)
    in_band = frequencies <= 4000
    magnitude = np.abs(spectrum[in_band])
    db = 20 * np.log10(np.maximum(magnitude, 1e-12) / max(float(magnitude.max()), 1e-12))

    inner = outer[row_index, 0].subgridspec(2, 1, height_ratios=[1.5, 1], hspace=.06)
    spectrogram = fig.add_subplot(inner[0])
    bars = fig.add_subplot(inner[1], sharex=spectrogram)
    mesh = spectrogram.pcolormesh(times + first / sample_rate, frequencies[in_band] / 1000,
                                 db, shading="auto", cmap="magma", norm=norm, rasterized=True)
    for value in (reference["start"], reference["end"]):
        spectrogram.axvline(value, color="white", ls=(0, (3, 3)), lw=1.0, alpha=.9)
        bars.axvline(value, color="#afb3b9", ls=(0, (2, 3)), lw=.8, zorder=0)
    spectrogram.set_ylim(0, 4)
    spectrogram.set_yticks([0, 2, 4])
    spectrogram.set_ylabel("кГц", rotation=0, labelpad=18)
    spectrogram.set_title(f"{chr(65 + row_index)}   {case_id}  ·  word[{word_index}]",
                          loc="left", fontsize=12, pad=9)
    spectrogram.tick_params(axis="x", labelbottom=False)
    for index, key in enumerate(("ref", "v3", "v4")):
        word = values[key]
        y = 2 - index
        bars.plot([word["start"], word["end"]], [y, y], lw=9,
                  color=colors[key], solid_capstyle="butt", zorder=2)
        bars.plot([word["start"], word["end"]], [y, y], "|", color=colors[key],
                  markersize=13, markeredgewidth=1.5, zorder=3)
    bars.set_yticks([2, 1, 0], ["Внешняя", "v3", "v4"])
    bars.set_ylim(-.55, 2.55)
    bars.set_xlim(left, right)
    bars.xaxis.set_major_locator(MultipleLocator(.25))
    bars.xaxis.set_major_formatter(FormatStrFormatter("%.2f"))
    bars.set_xlabel("Время внутри исходного WAV, с", labelpad=4, fontsize=10)
    bars.tick_params(axis="y", length=0, pad=9)
    bars.spines["left"].set_visible(False)
    bars.grid(axis="x", color="#e1e4e8", lw=.5, zorder=0)

    table = fig.add_subplot(outer[row_index, 1])
    table.set_axis_off()
    table.text(0, .94, "Границы и длительность, с", fontsize=11, weight="bold")
    table.text(0, .83, "             начало  конец   длит.", fontfamily="DejaVu Sans Mono",
               fontsize=10)
    measurements = {}
    for i, (key, label) in enumerate((("ref", "Внешняя"), ("v3", "v3"), ("v4", "v4"))):
        word = values[key]
        start, end = float(word["start"]), float(word["end"])
        table.text(0, .715 - .102 * i,
                   f"{label:<10} {start:6.3f}  {end:6.3f}  {end-start:6.3f}",
                   fontfamily="DejaVu Sans Mono", fontsize=10, color=colors[key])
        measurements[key] = {"start": start, "end": end, "duration": end - start,
                             "signedStartErrorMs": (start - reference["start"]) * 1000,
                             "signedEndErrorMs": (end - reference["end"]) * 1000}
    table.text(0, .365, "Ошибка к разметке, мс: начало / конец", fontsize=10)
    for i, key in enumerate(("v3", "v4")):
        word = values[key]
        table.text(0, .25 - .10 * i,
                   f"{key}   {signed_ms(word['start'] - reference['start']):>5} / "
                   f"{signed_ms(word['end'] - reference['end']):>5}",
                   fontfamily="DejaVu Sans Mono", fontsize=11, color=colors[key])
    boundary = "start" if focus == "Начало" else "end"
    old_error = round(abs(values["v3"][boundary] - reference[boundary]) * 1000)
    new_error = round(abs(values["v4"][boundary] - reference[boundary]) * 1000)
    table.text(0, -.005, f"{focus}: |ошибка| {old_error} → {new_error} мс",
               fontsize=11, weight="bold")
    rows.append({"case": case_id, "wordIndex": word_index,
                 "sourceAudio": {"path": str(audio_path), "sha256": sha256(audio_path),
                                 "sampleRate": sample_rate, "frames": len(waveform)},
                 "reference": {"path": str(reference_path), "sha256": sha256(reference_path),
                               "method": reference["referenceWordKind"],
                               "accuracyMs": reference["referenceAccuracyMs"]},
                 "predictionSources": {key: {"path": str(path), "sha256": sha256(path)}
                                       for key, path in payload_paths.items()},
                 "windowSeconds": [left, right], "measurements": measurements})

fig.suptitle("Реальные границы слов: внешняя разметка, v3 и v4",
             x=.085, y=.965, ha="left", fontsize=18, weight="bold")
fig.text(.085, .932,
         "Три проверенных изменения на исходных записях GTSinger · русский вокал",
         fontsize=11.5, color="#454b54")
color_axis = fig.add_axes([.60, .071, .25, .012])
colorbar = fig.colorbar(mesh, cax=color_axis, orientation="horizontal", ticks=[-60, -40, -20, 0])
colorbar.ax.tick_params(labelsize=9, length=2)
colorbar.set_label("Спектр: дБ относительно максимума окна", fontsize=9, labelpad=2)
fig.text(.085, .083,
         "Белый пунктир: границы внешней разметки.\n"
         "Спектр: Hann 40 мс, шаг 5 мс; исходный WAV без изменения.",
         fontsize=9.5, color="#454b54", linespacing=1.5)
fig.text(.085, .025,
         "Разметка GTSinger — внешняя, с ручной коррекцией; неопределённость границ не указана.\n"
         "Разметка не подавалась на вход алгоритму. Ошибки указаны относительно этих меток, не как абсолютная акустическая истина.",
         fontsize=9.5, color="#454b54", linespacing=1.5)
output.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(output, dpi=180, facecolor="white", metadata={"Software": "matplotlib"})
plt.close(fig)
script = Path(__file__).resolve()
manifest = {"scope": "Three selected independently referenced real improvements; not an aggregate accuracy score.",
            "referenceUncertainty": "Unspecified in published metadata; no confidence bounds invented.",
            "referenceFedToInference": False,
            "audioMutation": "None; read-only spectral visualization at original sample rate.",
            "spectrogram": {"window": "Hann", "frameSeconds": .04, "hopSeconds": .005,
                            "maximumFrequencyHz": 4000, "rangeDb": [-65, 0],
                            "normalization": "Peak magnitude within each displayed crop and 0–4 kHz band"},
            "figure": {"path": str(output), "sha256": sha256(output), "dpi": 180},
            "script": {"path": str(script), "sha256": sha256(script)},
            "versions": {"numpy": np.__version__, "scipy": scipy.__version__,
                         "matplotlib": matplotlib.__version__},
            "cases": rows}
manifest_path = output.with_suffix(".manifest.json")
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print(output)
print("figure sha256", manifest["figure"]["sha256"])
print(manifest_path)
