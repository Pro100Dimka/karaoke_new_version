from pathlib import Path
import threading
from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_spectrum import SpectrumPlan, measure_mix_spectrum


def shape_voice(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    target: Path,
    cancel: threading.Event,
    *,
    plan: SpectrumPlan | None = None,
) -> tuple[Path, SpectrumPlan]:
    if plan is None:
        plan = measure_mix_spectrum(voice, backing, cancel)
    if not plan["bands"]:
        return voice, plan
    filters = [
        f"equalizer=f={b['frequencyHz']:.6f}:t=q:w=0.7:g={b['gainDb']:.6f}" for b in plan["bands"]
    ]
    renderer._mix(
        voice,
        backing,
        "[0:a]" + ",".join(filters) + "[out]",
        ["-c:a", "pcm_f32le", str(target)],
        cancel,
    )
    return target, plan
