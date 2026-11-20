"""Regenerate synthetic gapless MP3 fixtures and independent FFmpeg PCM references."""

from pathlib import Path
import subprocess


root = Path(__file__).resolve().parent
for rate in (44100, 48000):
    target = root / f"seek-{rate}.mp3"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(root / f"seek-{rate}.flac"),
            "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "320k",
            "-id3v2_version", "0", "-write_xing", "1", str(target),
        ],
        check=True,
    )
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(target), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    assert len(pcm) == rate * 2 * 2 * 4
    positions = (0, 1, 529, 1152, rate + 17, rate * 2 - 64)
    target.with_suffix(".reference.f32").write_bytes(
        b"".join(pcm[frame * 8 : (frame + 64) * 8] for frame in positions)
    )
