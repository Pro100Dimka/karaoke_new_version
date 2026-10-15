"""Export auditable native PCM contexts; never use these clips to replace the accepted lag gate."""
import json
import sys
import wave
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfiltfilt
from analyze_real_mic import locate

HERE = Path(__file__).resolve().parent


def read_native(path, begin, count):
    with wave.open(str(path), "rb") as stream:
        assert stream.getsampwidth() == 2 and stream.getframerate() == 48_000
        stream.setpos(int(begin))
        pcm = np.frombuffer(stream.readframes(int(count)), dtype="<i2").reshape(-1, stream.getnchannels())
        return pcm.astype(np.float64) / 32768


def write_native(path, pcm):
    if pcm.ndim == 1:
        pcm = pcm[:, None]
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(pcm.shape[1])
        stream.setsampwidth(2)
        stream.setframerate(48_000)
        stream.writeframes(np.clip(np.rint(pcm * 32768), -32768, 32767).astype("<i2").tobytes())


def main():
    coordinates_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE / "host-to-laptop-final-gap-coordinates.json"
    coordinates = json.loads(coordinates_path.read_text(encoding="utf-8-sig"))
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else HERE / "A-missing-voice-snippets"
    output.mkdir(exist_ok=True)
    band = butter(4, [300, 3400], fs=48_000, btype="bandpass", output="sos")
    entries = []
    for number, event in enumerate(coordinates["events"], 1):
        before = after = 24_000
        receiver_begin = event["receiverWavStartFrame"] - before
        count = before + event["receiverWavFrameCount"] + after
        master = read_native(HERE / coordinates["receiverMaster"], receiver_begin, count)
        backing = read_native(HERE / coordinates["renderedBacking"], receiver_begin, count)
        residual = master[:, 0] - backing[:, 0]
        search_guard = 4_800
        sender_hint = event["senderWavExpectedFrame"] - before
        sender_begin = sender_hint - search_guard
        sender = read_native(HERE / coordinates["senderMic"], sender_begin, count + 2 * search_guard)[:, 0]
        match = locate(sosfiltfilt(band, residual), sosfiltfilt(band, sender),
                       0, 2 * search_guard + 1, 48_000)
        accepted = match["position"] is not None and match["ncc"] >= 0.2 and match["uniquePeak"]
        shift = round(match["position"]) if accepted else search_guard
        matched_mic = sender[shift:shift + count]
        kind = "clean" if event.get("cleanReferenceContext") else "gap"
        prefix = f"{kind}-{number:02d}-song-{event['songSeconds']:.3f}"
        files = {"master": output / (prefix + "-master.wav"),
                 "remoteResidual": output / (prefix + "-remote-residual.wav"),
                 "senderRealMic": output / (prefix + "-sender-real-mic.wav")}
        for key, pcm in (("master", master), ("remoteResidual", residual), ("senderRealMic", matched_mic)):
            write_native(files[key], pcm)
        begin, end = before, before + event["receiverWavFrameCount"]
        entries.append({**event, "contextBeforeSeconds": 0.5, "contextAfterSeconds": 0.5,
                        "receiverClipStartFrame": receiver_begin,
                        "senderMatchedClipStartFrame": sender_begin + shift,
                        "localMatchAdjustmentFrames": shift - search_guard,
                        "contextIdentityStatus": "IDENTIFIED" if accepted else "UNIDENTIFIED",
                        "senderReferenceAlignment": "constant local NCC offset" if accepted else
                            event.get("senderHintMethod", "clock-derived hint") + "; no low-confidence NCC offset applied",
                        "contextNcc": match["ncc"], "contextSecondPeakNcc": match["secondPeakNcc"],
                        "contextUniquePeak": match["uniquePeak"],
                        "residualGapPeak": float(np.max(np.abs(residual[begin:end]))),
                        "senderGapRms": float(np.sqrt(np.mean(matched_mic[begin:end] ** 2))),
                        "paths": {key: str(file.relative_to(HERE)) for key, file in files.items()}})
    manifest = {"coordinateSource": coordinates_path.name,
                "method": "Native 48 kHz excerpts with 0.5 seconds before and after each verified missing interval. "
                          "Remote residual is master channel 0 minus the exact simultaneously recorded backing channel 0. "
                          "Sender reference uses one constant locally correlated offset per context only when NCC >=0.2 with a unique peak; "
                          "otherwise it retains the clock-derived hint and is explicitly unidentified. No stretching, "
                          "resampling, gain normalization or dynamics. Context NCC is for clip identity only, "
                          "not a replacement lag/drift acceptance result.",
                "events": entries}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps([{k: e[k] for k in ("songSeconds", "durationMs", "contextNcc", "residualGapPeak", "senderGapRms")}
                      for e in entries], indent=2))


if __name__ == "__main__":
    main()
