"""A tiny PNG encoder built on zlib alone.

The fallback engine has no Pillow/numpy to lean on, so Forge ships its own
encoder. It also lets us bake generation settings into the file as tEXt
chunks, which means every PNG the app writes carries the recipe that made it.
"""

from __future__ import annotations

import struct
import zlib
from typing import Iterable, Mapping

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def _text_chunks(text: Mapping[str, str]) -> Iterable[bytes]:
    for key, value in text.items():
        # tEXt keywords are latin-1, 1-79 chars, and cannot contain a NUL.
        k = str(key).encode("latin-1", "replace")[:79].replace(b"\x00", b" ")
        v = str(value).encode("latin-1", "replace").replace(b"\x00", b" ")
        if not k:
            continue
        yield _chunk(b"tEXt", k + b"\x00" + v)


def encode_png(
    width: int,
    height: int,
    rgb: bytes | bytearray,
    text: Mapping[str, str] | None = None,
    compress_level: int = 6,
) -> bytes:
    """Encode raw 8-bit RGB pixels (row-major, no padding) as a PNG file."""
    expected = width * height * 3
    if len(rgb) != expected:
        raise ValueError(f"expected {expected} bytes of RGB data, got {len(rgb)}")

    stride = width * 3
    # Filter type 0 (None) per scanline: cheap to produce, and zlib still gets
    # good ratios on the smooth gradients this app tends to make.
    raw = bytearray((stride + 1) * height)
    pos = 0
    for y in range(height):
        start = y * stride
        raw[pos] = 0
        raw[pos + 1 : pos + 1 + stride] = rgb[start : start + stride]
        pos += stride + 1

    out = bytearray(PNG_MAGIC)
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    for chunk in _text_chunks(text or {}):
        out += chunk
    out += _chunk(b"IDAT", zlib.compress(bytes(raw), compress_level))
    out += _chunk(b"IEND", b"")
    return bytes(out)


def read_size(data: bytes) -> tuple[int, int]:
    """Read (width, height) out of a PNG header. Used to validate uploads."""
    if not data.startswith(PNG_MAGIC) or len(data) < 24:
        raise ValueError("not a PNG file")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


# --------------------------------------------------------------- animation

def _idat_payload(
    width: int, height: int, rgb: bytes | bytearray, compress_level: int
) -> bytes:
    """Filter and compress one frame exactly as `encode_png` does for IDAT."""
    stride = width * 3
    raw = bytearray((stride + 1) * height)
    pos = 0
    for y in range(height):
        start = y * stride
        raw[pos] = 0
        raw[pos + 1 : pos + 1 + stride] = rgb[start : start + stride]
        pos += stride + 1
    return zlib.compress(bytes(raw), compress_level)


def _fctl(
    sequence: int, width: int, height: int, delay_num: int, delay_den: int
) -> bytes:
    # dispose_op 0 (APNG_DISPOSE_OP_NONE), blend_op 0 (APNG_BLEND_OP_SOURCE):
    # every frame here is a full replacement, which keeps this simple and exact.
    return _chunk(
        b"fcTL",
        struct.pack(
            ">IIIIIHHBB",
            sequence, width, height, 0, 0, delay_num, delay_den, 0, 0,
        ),
    )


def encode_apng(
    width: int,
    height: int,
    frames: list[bytes] | list[bytearray],
    fps: float = 12.0,
    text: Mapping[str, str] | None = None,
    loops: int = 0,
    compress_level: int = 6,
) -> bytes:
    """Encode raw RGB frames as an animated PNG.

    APNG is the one animation format reachable from the standard library alone -
    zlib is all it needs - and every current browser plays it. That keeps video
    working on a machine with nothing installed, which is the whole point of the
    app. When ffmpeg is present, `video.py` prefers MP4 instead.

    `loops` of 0 means loop forever.
    """
    if not frames:
        raise ValueError("at least one frame is required")
    expected = width * height * 3
    for index, frame in enumerate(frames):
        if len(frame) != expected:
            raise ValueError(
                f"frame {index} has {len(frame)} bytes, expected {expected}"
            )

    fps = max(0.1, min(float(fps), 60.0))
    # Delays are a rational number of seconds; a denominator of 1000 keeps
    # ordinary frame rates exact enough and is what most encoders use.
    delay_den = 1000
    delay_num = max(1, int(round(delay_den / fps)))

    out = bytearray(PNG_MAGIC)
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    for chunk in _text_chunks(text or {}):
        out += chunk
    out += _chunk(b"acTL", struct.pack(">II", len(frames), max(0, int(loops))))

    sequence = 0
    out += _fctl(sequence, width, height, delay_num, delay_den)
    sequence += 1
    # The first frame is a plain IDAT, so non-APNG readers still see an image.
    out += _chunk(b"IDAT", _idat_payload(width, height, frames[0], compress_level))

    for frame in frames[1:]:
        out += _fctl(sequence, width, height, delay_num, delay_den)
        sequence += 1
        payload = _idat_payload(width, height, frame, compress_level)
        out += _chunk(b"fdAT", struct.pack(">I", sequence) + payload)
        sequence += 1

    out += _chunk(b"IEND", b"")
    return bytes(out)


def read_apng_info(data: bytes) -> dict[str, int]:
    """Read frame count and play count back out of an APNG. Used by tests."""
    if not data.startswith(PNG_MAGIC):
        raise ValueError("not a PNG file")
    pos = len(PNG_MAGIC)
    info = {"frames": 0, "plays": 0, "fctl": 0, "fdat": 0}
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        kind = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        if kind == b"acTL":
            info["frames"], info["plays"] = struct.unpack(">II", payload)
        elif kind == b"fcTL":
            info["fctl"] += 1
        elif kind == b"fdAT":
            info["fdat"] += 1
        elif kind == b"IEND":
            break
        pos += 12 + length
    return info
