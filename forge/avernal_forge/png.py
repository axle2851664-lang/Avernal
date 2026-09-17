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
