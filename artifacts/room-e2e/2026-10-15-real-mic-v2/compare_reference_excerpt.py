"""Report-only existing NCC implementation; no application or gate changes.

python compare_reference_excerpt.py config.json strict-result.json output.json
Writes the same 25/30/35 song-second residual against both references.
"""
import csv
import json
from pathlib import Path
import sys

from scipy.signal import butter, sosfiltfilt
import analyze_real_mic as a


config_path, strict_path, out_path = map(Path, sys.argv[1:4])
config = json.loads(config_path.read_text(encoding="utf-8"))
strict = json.loads(strict_path.read_text(encoding="utf-8"))
paths = {key: Path(value) if Path(value).is_absolute() else config_path.parent / value
         for key, value in config.items() if key in ("receiverMaster", "senderMic", "studioVocal", "renderedBacking")}
pcm = {key: a.read_channel(path, config.get(key + "Channel", 0)) for key, path in paths.items()}
timeline, _ = a.read_timeline(str(paths["senderMic"]) + ".timeline.csv", "sender",
                             pcm["senderMic"][1]["frames"], pcm["senderMic"][1]["sampleRate"])
origin = a.sender_song_origin(timeline, config["songStartRoomFrame"], 48000)
band = butter(4, [300, 3400], fs=a.RATE, btype="bandpass", output="sos")
signals = {key: sosfiltfilt(band, pcm[key][0]) for key in ("senderMic", "studioVocal")}
residual = sosfiltfilt(band, pcm["receiverMaster"][0] - pcm["renderedBacking"][0])
entries, traces = [], []
original_find_peaks = a.find_peaks


def capture_existing_ncc(values, *args, **kwargs):
    # Save the exact array already computed by locate(), not a second formula.
    traces.append(values.copy())
    return original_find_peaks(values, *args, **kwargs)


a.find_peaks = capture_existing_ncc
for song_at in (25, 30, 35):
    begin = round((song_at - strict["fileStartsAtSongSeconds"]) * a.RATE)
    chunk = residual[begin:begin + a.RATE]
    entry = {"songSeconds": song_at, "durationSeconds": 1,
             "receiverWavStartFrameAt8k": begin, "references": {}}
    for role, center in (("senderMic", (song_at - origin) * a.RATE), ("studioVocal", song_at * a.RATE)):
        search_begin = max(0, int(center - a.RATE))
        match = a.locate(chunk, signals[role], center - a.RATE, center + a.RATE / 4, a.RATE)
        entry["references"][role] = match
        if song_at == 25:
            path = out_path.with_name(out_path.stem + "-" + role + ".csv")
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(("offsetMs", "absoluteNcc"))
                writer.writerows(((search_begin + index - center) / a.RATE * 1000, float(value))
                                 for index, value in enumerate(traces[-1]))
            entry["references"][role]["curveCsv"] = path.name
    entries.append(entry)
out = {"config": str(config_path), "strictResult": str(strict_path),
       "method": "Same exact master-minus-rendered-backing excerpt, constant-rate resample8k, DC removal within existing locate(), band300-3400; identical NCC .2 and separated-peak50ms gates; no stretch",
       "note": "This B recording has valid timing/reference signal; its initial quiet calibration was contaminated by sender backing, so it is not the final dropout run.",
       "excerpts": entries}
out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
print(json.dumps([{ "songSeconds": x["songSeconds"], "mic": x["references"]["senderMic"]["ncc"],
                    "studio": x["references"]["studioVocal"]["ncc"]} for x in entries], indent=2))
