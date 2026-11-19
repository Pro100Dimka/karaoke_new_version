"""Measure the encoded master without running a discarded dynamic normalization."""

from pathlib import Path
import re
import threading

from backend.infrastructure.ffmpeg_audio import parse_loudness
from backend.recordings.studio_audio import MasterRenderer


# Dynamic loudnorm uses double samples at 192 kHz to meter true peaks. Keep
# exactly that resampling, including its EOF flush, while selecting unity linear
# output. These measured_* options only configure the discarded output; input_*
# in the returned JSON still measure the actual file. astats avoids rounding a
# peak just above -1 dBTP down to -1.00 before the delivery ceiling is checked.
_METER = (
    "aformat=sample_fmts=dbl:sample_rates=192000,"
    "astats=reset=0:measure_perchannel=none:measure_overall=Peak_level,"
    "loudnorm=I=-14:LRA=11:TP=-1:linear=true:measured_I=-14:"
    "measured_LRA=1:measured_TP=-99:measured_thresh=-99:print_format=json"
)


def measure_master_levels(
    renderer: MasterRenderer, path: Path, cancel: threading.Event
) -> dict[str, float] | None:
    result = renderer._mix(
        path, path, "[0:a]" + _METER + "[out]", ["-f", "null", "-"], cancel, quiet=False
    )
    levels = parse_loudness(result.stderr)
    peaks = re.findall(rb"\[Parsed_astats[^\]]*\]\s+Peak level dB:\s+(\S+)", result.stderr)
    if levels is None or not peaks:
        return None
    try:
        levels["input_tp"] = float(peaks[-1])
    except ValueError:
        return None
    return levels
