"""Turning rendered frames into a file the browser can play.

Two paths, in order of preference:

* **MP4** (H.264) when ffmpeg is on the machine - small, seekable, universally
  playable.
* **APNG** otherwise - written by `png.py` with nothing but zlib, so a clip
  still comes out on a machine with nothing installed. Every current browser
  plays it.

The fallback is not a degraded mode you have to opt into; it is what keeps the
app's "works with nothing installed" promise true for video as well.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Mapping

from .png import encode_apng

#: format id -> (mime type, file extension)
VIDEO_FORMATS: dict[str, tuple[str, str]] = {
    "mp4": ("video/mp4", ".mp4"),
    "apng": ("image/apng", ".png"),
}

MIN_FPS = 1
MAX_FPS = 60
MIN_FRAMES = 2
MAX_FRAMES = 240

_ffmpeg_cache: list[str | None] = []


def ffmpeg_path() -> str | None:
    """Locate ffmpeg once per process."""
    if not _ffmpeg_cache:
        _ffmpeg_cache.append(shutil.which("ffmpeg"))
    return _ffmpeg_cache[0]


def available_formats() -> list[str]:
    return (["mp4"] if ffmpeg_path() else []) + ["apng"]


def default_format() -> str:
    return "mp4" if ffmpeg_path() else "apng"


def _encode_mp4(
    width: int,
    height: int,
    frames: list[bytes],
    fps: float,
    text: Mapping[str, str] | None,
) -> bytes:
    binary = ffmpeg_path()
    if not binary:
        raise RuntimeError("ffmpeg is not installed")

    comment = json.dumps(dict(text or {}), separators=(",", ":"))[:4000]
    with tempfile.TemporaryDirectory() as workdir:
        target = Path(workdir) / "clip.mp4"
        command = [
            binary, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-r", f"{fps:g}",
            "-i", "pipe:0", "-an",
            # yuv420p needs even dimensions for the widest player support.
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            "-metadata", f"comment={comment}",
            str(target),
        ]
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            for frame in frames:
                process.stdin.write(frame)
            process.stdin.close()
        except BrokenPipeError:
            pass
        _, stderr = process.communicate(timeout=600)
        if process.returncode != 0 or not target.is_file():
            detail = stderr.decode("utf-8", "replace").strip()[:400]
            raise RuntimeError(f"ffmpeg failed: {detail or 'no output produced'}")
        return target.read_bytes()


def encode_video(
    width: int,
    height: int,
    frames: list[bytes],
    fps: float = 12.0,
    text: Mapping[str, str] | None = None,
    wanted: str = "auto",
    on_note: Any = None,
) -> tuple[bytes, str, str, str]:
    """Encode frames, returning (data, format id, mime type, file extension).

    `wanted` may be "auto", "mp4" or "apng". A failing ffmpeg falls back to
    APNG rather than failing the job - a clip in a different container beats
    no clip at all.
    """
    if not frames:
        raise ValueError("at least one frame is required")

    wanted = (wanted or "auto").lower()
    if wanted not in ("auto", "mp4", "apng"):
        raise ValueError(f"unknown video format {wanted!r}")
    chosen = default_format() if wanted == "auto" else wanted

    if chosen == "mp4":
        try:
            data = _encode_mp4(width, height, frames, fps, text)
            mime, ext = VIDEO_FORMATS["mp4"]
            return data, "mp4", mime, ext
        except Exception as exc:
            if wanted == "mp4" and not ffmpeg_path():
                raise RuntimeError(
                    "MP4 output needs ffmpeg on this machine. Install it, or "
                    "use the apng format."
                ) from exc
            if callable(on_note):
                on_note(f"ffmpeg unavailable ({exc}); wrote an animated PNG instead")

    data = encode_apng(width, height, frames, fps=fps, text=text)
    mime, ext = VIDEO_FORMATS["apng"]
    return data, "apng", mime, ext
