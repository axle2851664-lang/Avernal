"""The built-in engine: a prompt-conditioned procedural renderer.

This is deliberately NOT a neural model and never pretends to be one. It reads
the prompt for colour, mood and composition cues and renders layered
domain-warped noise fields through a derived palette. Pure stdlib, so a fresh
clone generates images immediately - no weights, no downloads, no GPU.

Install the optional extras and drop a checkpoint in the models folder to get
real Stable Diffusion output from `diffusers_engine.py` instead.
"""

from __future__ import annotations

import math
import random
import re
import time
from typing import Any, Iterator

from ..png import encode_png
from ..video import encode_video
from .base import Engine, GeneratedMedia, GenerationRequest, JobContext

# ---------------------------------------------------------------- prompt cues

HUES: dict[str, int] = {
    "red": 0, "scarlet": 8, "crimson": 348, "ruby": 350, "blood": 355,
    "orange": 25, "copper": 20, "bronze": 30, "rust": 18, "amber": 40,
    "gold": 45, "golden": 45, "sand": 38, "desert": 36, "yellow": 52,
    "lime": 80, "green": 130, "forest": 140, "jungle": 135, "emerald": 150,
    "mint": 155, "teal": 175, "cyan": 188, "ice": 195, "sea": 195,
    "ocean": 200, "sky": 200, "azure": 210, "snow": 210, "blue": 220,
    "sapphire": 225, "night": 235, "midnight": 240, "indigo": 245,
    "violet": 265, "dusk": 270, "lavender": 270, "purple": 280,
    "magenta": 310, "pink": 330, "rose": 345, "sunset": 15, "sunrise": 35,
    "dawn": 30, "autumn": 28, "spring": 110, "summer": 48, "winter": 205,
    "cyberpunk": 300, "synthwave": 290, "vaporwave": 315, "neon": 300,
    "toxic": 90, "coral": 12, "salmon": 10, "peach": 22, "honey": 42,
    "lemon": 55, "olive": 75, "moss": 100, "sage": 120, "ivy": 135,
    "pine": 145, "aqua": 180, "turquoise": 174, "cobalt": 215, "navy": 228,
    "plum": 290, "lilac": 275, "wine": 340, "cherry": 350, "blossom": 335,
    "terracotta": 15, "moon": 210, "fire": 18, "ember": 22, "steel": 210,
}

MONO_WORDS = {"monochrome", "grayscale", "greyscale", "noir", "charcoal",
              "silver", "graphite", "ink", "black", "white", "mono"}

STYLES: dict[str, tuple[str, ...]] = {
    "horizon": ("landscape", "mountain", "mountains", "valley", "horizon",
                "desert", "sea", "ocean", "lake", "field", "fields", "sunset",
                "sunrise", "dunes", "coast", "beach", "plains", "vista",
                "island", "river", "canyon", "tundra"),
    "cosmic": ("space", "galaxy", "nebula", "star", "stars", "starfield",
               "cosmic", "universe", "celestial", "aurora", "void", "orbit",
               "planet", "astral"),
    "bands": ("geometric", "grid", "city", "cityscape", "architecture",
              "building", "buildings", "brutalist", "structure", "minimal",
              "minimalist", "bauhaus", "poster", "stripes", "skyline"),
    "radial": ("portrait", "face", "character", "figure", "person", "mask",
               "eye", "bloom", "flower", "orb", "sphere", "lens", "mandala",
               "sun", "moon"),
    "flow": ("abstract", "fluid", "liquid", "swirl", "smoke", "silk", "marble",
             "waves", "wave", "flow", "organic", "dream", "dreamy", "vapor",
             "clouds", "mist"),
}

DARK_WORDS = {"dark", "darkness", "moody", "shadow", "shadows", "night",
              "midnight", "noir", "gloom", "storm", "stormy", "deep", "black"}
BRIGHT_WORDS = {"bright", "vivid", "neon", "glow", "glowing", "radiant",
                "luminous", "electric", "vibrant", "sunlit", "brilliant"}
SOFT_WORDS = {"pastel", "soft", "calm", "gentle", "serene", "hazy", "muted",
              "faded", "vintage", "dusty", "quiet", "subtle"}
SHARP_WORDS = {"sharp", "crisp", "detailed", "intricate", "complex", "chaotic",
               "turbulent", "fractal", "detail", "busy"}


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z]+", text.lower())


# ------------------------------------------------------------------- palettes

def _hue_lerp(h1: float, h2: float, t: float) -> float:
    """Interpolate hues along the shorter arc of the colour wheel."""
    delta = ((h2 - h1 + 180.0) % 360.0) - 180.0
    return h1 + delta * t


def _hsl_to_rgb(h: float, s: float, ell: float) -> tuple[int, int, int]:
    h = (h % 360.0) / 360.0
    if s <= 0:
        v = int(round(max(0.0, min(1.0, ell)) * 255))
        return v, v, v
    q = ell * (1 + s) if ell < 0.5 else ell + s - ell * s
    p = 2 * ell - q

    def channel(t: float) -> int:
        t = t % 1.0
        if t < 1 / 6:
            c = p + (q - p) * 6 * t
        elif t < 0.5:
            c = q
        elif t < 2 / 3:
            c = p + (q - p) * (2 / 3 - t) * 6
        else:
            c = p
        return int(round(max(0.0, min(1.0, c)) * 255))

    return channel(h + 1 / 3), channel(h), channel(h - 1 / 3)


def _parse_palette(colours: list[str] | None) -> list[tuple[int, int, int]]:
    """Accept #rrggbb strings from a sampled reference image.

    Returns [] unless at least two parse, so a bad payload falls back to the
    prompt-derived palette rather than rendering something broken.
    """
    if not colours:
        return []
    parsed: list[tuple[int, int, int]] = []
    for value in colours[:8]:
        text = str(value).strip().lstrip("#")
        if len(text) == 3:
            text = "".join(ch * 2 for ch in text)
        if len(text) != 6:
            continue
        try:
            parsed.append(tuple(int(text[i:i + 2], 16) for i in (0, 2, 4)))
        except ValueError:
            continue
    if len(parsed) < 2:
        return []
    # The renderer maps a 0..1 field through this ramp, so it has to run dark
    # to light or the image reads inverted.
    parsed.sort(key=lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
    return parsed


class Style:
    """Everything the renderer derived from the prompt, in one place."""

    def __init__(self, prompt: str, negative: str, rng: random.Random,
                 palette: list[str] | None = None) -> None:
        words = _tokens(prompt)
        word_set = set(words)
        avoid = set(_tokens(negative))

        # --- composition
        self.kind = "flow"
        best = 10**9
        for kind, keys in STYLES.items():
            for key in keys:
                if key in word_set and key not in avoid:
                    pos = words.index(key)
                    if pos < best:
                        best, self.kind = pos, kind
        if best == 10**9:
            self.kind = rng.choice(["flow", "horizon", "radial", "bands", "cosmic"])

        # --- colour
        hits = [HUES[w] for w in words if w in HUES and w not in avoid]
        self.mono = bool(word_set & MONO_WORDS) and not hits
        if hits:
            self.hue = float(hits[0])
            self.hue2 = float(hits[1]) if len(hits) > 1 else None
        else:
            self.hue = rng.uniform(0, 360)
            self.hue2 = None

        dark = bool(word_set & DARK_WORDS)
        bright = bool(word_set & BRIGHT_WORDS)
        soft = bool(word_set & SOFT_WORDS)
        sharp = bool(word_set & SHARP_WORDS)

        self.saturation = 0.55
        if bright:
            self.saturation += 0.28
        if soft:
            self.saturation -= 0.3
        if self.mono:
            self.saturation = 0.03
        self.saturation = max(0.0, min(0.95, self.saturation + rng.uniform(-0.05, 0.05)))

        self.lightness = 0.5
        if dark:
            self.lightness -= 0.16
        if bright:
            self.lightness += 0.08
        if soft:
            self.lightness += 0.12
        self.lightness = max(0.2, min(0.78, self.lightness + rng.uniform(-0.03, 0.03)))

        self.contrast = 1.25 if sharp else (0.85 if soft else 1.0)
        self.warp = 0.9 if self.kind == "flow" else 0.45
        if sharp:
            self.warp += 0.35
        self.grain = 5 if soft else (14 if sharp else 9)
        self.glow = bright or self.kind == "cosmic"
        supplied = _parse_palette(palette)
        self.palette = supplied or self._build_palette(rng)
        self.from_reference = bool(supplied)
        if supplied:
            # A sampled palette already carries the reference's mood; leaving
            # the prompt-derived contrast on top of it double-counts.
            self.contrast = min(self.contrast, 1.05)
        self.lut = self._build_lut()

    def _build_palette(self, rng: random.Random) -> list[tuple[int, int, int]]:
        h1 = self.hue
        if self.hue2 is not None:
            h2 = self.hue2
        else:
            spread = rng.choice([-55, -40, -28, 28, 40, 55, 72, -72, 150, -150])
            h2 = h1 + spread
        s, ell = self.saturation, self.lightness
        stops = [
            (h1 - 12, s * 0.75, max(0.04, ell * 0.16)),   # deep shadow
            (h1, s * 0.95, ell * 0.48),                    # shadow
            (_hue_lerp(h1, h2, 0.5), s, ell),              # mid
            (_hue_lerp(h1, h2, 0.82), min(1.0, s * 1.05), min(0.92, ell * 1.34)),  # light
            (h2 + 14, min(1.0, s * 0.7), min(0.98, ell * 1.72)),  # highlight
        ]
        return [_hsl_to_rgb(h, sat, lum) for h, sat, lum in stops]

    def _build_lut(self) -> list[tuple[int, int, int]]:
        """256-entry colour ramp so the pixel loop is a lookup, not a curve."""
        pal = self.palette
        segments = len(pal) - 1
        lut: list[tuple[int, int, int]] = []
        for i in range(256):
            t = i / 255.0
            # Contrast curve around the midpoint keeps mids from muddying.
            t = 0.5 + (t - 0.5) * self.contrast
            t = max(0.0, min(1.0, t))
            pos = t * segments
            idx = min(segments - 1, int(pos))
            f = pos - idx
            f = f * f * (3 - 2 * f)
            a, b = pal[idx], pal[idx + 1]
            lut.append(
                (
                    int(a[0] + (b[0] - a[0]) * f),
                    int(a[1] + (b[1] - a[1]) * f),
                    int(a[2] + (b[2] - a[2]) * f),
                )
            )
        return lut


# ---------------------------------------------------------------------- noise

class Lattice:
    """Tileable value-noise lattice with smoothstep interpolation."""

    __slots__ = ("n", "v")

    def __init__(self, rng: random.Random, n: int = 64) -> None:
        self.n = n
        self.v = [rng.random() for _ in range(n * n)]

    def sample(self, x: float, y: float) -> float:
        n, v = self.n, self.v
        x %= n
        y %= n
        x0 = int(x)
        y0 = int(y)
        xf = x - x0
        yf = y - y0
        x1 = x0 + 1 if x0 + 1 < n else 0
        y1 = y0 + 1 if y0 + 1 < n else 0
        u = xf * xf * (3 - 2 * xf)
        w = yf * yf * (3 - 2 * yf)
        r0 = y0 * n
        r1 = y1 * n
        a = v[r0 + x0]
        b = v[r0 + x1]
        c = v[r1 + x0]
        d = v[r1 + x1]
        top = a + (b - a) * u
        bot = c + (d - c) * u
        return top + (bot - top) * w

    def fbm(self, x: float, y: float, octaves: int) -> float:
        total = 0.0
        amp = 0.5
        norm = 0.0
        freq = 1.0
        for _ in range(octaves):
            total += self.sample(x * freq, y * freq) * amp
            norm += amp
            amp *= 0.5
            freq *= 2.0
        return total / norm if norm else 0.0


# ------------------------------------------------------------------- renderer

class ProceduralEngine(Engine):
    id = "procedural"
    label = "Procedural (no weights)"
    description = (
        "Built-in renderer. Reads the prompt for colour, mood and composition "
        "cues and paints layered noise fields, still or moving. Not a trained "
        "model - it runs anywhere, instantly, with nothing installed."
    )
    is_neural = False
    supports_video = True

    def available(self) -> bool:
        return True

    def device_label(self) -> str:
        return "cpu"

    def models(self) -> list[dict[str, Any]]:
        return [
            {
                "id": "procedural",
                "name": "Forge Procedural v1",
                "engine": self.id,
                "kind": "builtin",
                "path": "",
                "size_bytes": 0,
            }
        ]

    # -- field -------------------------------------------------------------

    def _field_size(self, width: int, height: int, steps: int) -> tuple[int, int]:
        """Noise is evaluated coarsely and interpolated - `steps` buys detail."""
        longest = max(96, min(384, 96 + steps * 7))
        if width >= height:
            fw = min(longest, width)
            fh = max(16, int(fw * height / width))
        else:
            fh = min(longest, height)
            fw = max(16, int(fh * width / height))
        return fw, fh

    @staticmethod
    def _field_setup(rng: random.Random) -> dict[str, Any]:
        """Everything a field needs that must NOT change between frames.

        Drawing these once is what keeps a clip stable: re-rolling the lattice
        or the composition per frame would make the whole image boil.
        """
        return {
            "lat": Lattice(rng, 64),
            "warp_lat": Lattice(rng, 32),
            "scale": rng.uniform(2.2, 3.8),
            "ox": rng.uniform(0, 40),
            "oy": rng.uniform(0, 40),
            "horizon": rng.uniform(0.42, 0.62),
            "haze": rng.uniform(0.05, 0.14),
            "cx": rng.uniform(0.38, 0.62),
            "cy": rng.uniform(0.36, 0.58),
            "rings": rng.randint(3, 7),
            "cols": rng.randint(3, 8),
            "rows": rng.randint(3, 8),
            "cells": [rng.random() for _ in range(64)],
            "gutter": rng.uniform(0.012, 0.035),
        }

    def _build_field(
        self,
        style: Style,
        setup: dict[str, Any],
        fw: int,
        fh: int,
        octaves: int,
        ctx: JobContext,
        base_step: int,
        total_steps: int,
        phase: float = 0.0,
        motion: float = 1.0,
        norm: tuple[float, float] | None = None,
    ) -> tuple[list[float], tuple[float, float]]:
        lat = setup["lat"]
        warp_lat = setup["warp_lat"]
        scale = setup["scale"]
        warp = style.warp
        kind = style.kind
        horizon = setup["horizon"]
        haze = setup["haze"]                    # softness of the horizon line
        sigma2 = 2.0 * (haze * 0.9) ** 2        # width of the light band on it
        cx, cy = setup["cx"], setup["cy"]
        rings = setup["rings"]
        cols, rows = setup["cols"], setup["rows"]
        cells = setup["cells"]
        gutter = setup["gutter"]
        fbm = lat.fbm
        wfbm = warp_lat.fbm

        # Motion walks the sampling point around a circle. Because the lattice
        # wraps, phase 1.0 lands exactly back on phase 0.0, so the clip loops
        # with no visible seam.
        angle = 2.0 * math.pi * phase
        drift = 0.42 * max(0.0, motion)
        ox = setup["ox"] + math.cos(angle) * drift
        oy = setup["oy"] + math.sin(angle) * drift
        # The warp layer turns the other way, so the texture churns internally
        # instead of only sliding.
        wox = math.cos(-angle) * drift * 0.6
        woy = math.sin(-angle) * drift * 0.6

        field = [0.0] * (fw * fh)
        for j in range(fh):
            if j % 16 == 0:
                ctx.check_cancel()
                ctx.progress(base_step + int(j / fh * 6), total_steps, "fields")
            v_norm = j / fh
            row = j * fw
            for i in range(fw):
                u_norm = i / fw
                # Domain warp: the noise looks up a displaced coordinate, which
                # is what turns bland fbm into something that flows.
                wx = wfbm(u_norm * 2.0 + ox + wox, v_norm * 2.0 + oy + woy, 2) - 0.5
                wy = wfbm(u_norm * 2.0 + ox + wox + 9.7,
                          v_norm * 2.0 + oy + woy + 4.1, 2) - 0.5
                x = u_norm * scale + wx * warp
                y = v_norm * scale + wy * warp
                v = fbm(x + ox, y + oy, octaves)

                if kind == "horizon":
                    # Everything here stays continuous across the horizon;
                    # a hard cut reads as a rendering bug, not as a skyline.
                    d = v_norm - horizon
                    ground = d / haze
                    ground = 0.0 if ground <= 0 else (1.0 if ground >= 1 else
                                                      ground * ground * (3 - 2 * ground))
                    glow = math.exp(-(d * d) / sigma2)
                    sky_grad = 1.0 - v_norm
                    v = (
                        v * (0.22 + 0.34 * ground)
                        + sky_grad * 0.42 * (1.0 - ground)
                        + glow * 0.34
                        + (1.0 - ground) * 0.12
                    )
                elif kind == "radial":
                    dx = (u_norm - cx) * 1.35
                    dy = v_norm - cy
                    r = math.sqrt(dx * dx + dy * dy)
                    falloff = max(0.0, 1.0 - r * 1.75)
                    v = (
                        v * 0.46
                        + falloff * falloff * 0.7
                        + math.sin(r * rings * math.pi) * 0.07
                    )
                elif kind == "cosmic":
                    dx = (u_norm - cx) * 1.2
                    dy = v_norm - cy
                    r = math.sqrt(dx * dx + dy * dy)
                    v = (v ** 1.7) * 1.35 + max(0.0, 0.85 - r * 1.5) * 0.45
                elif kind == "bands":
                    # Flat cells separated by thin gutters: architectural
                    # rather than the camouflage that value-quantising gives.
                    ci = int(u_norm * cols)
                    cj = int(v_norm * rows)
                    ci = cols - 1 if ci >= cols else ci
                    cj = rows - 1 if cj >= rows else cj
                    tone = cells[(cj * cols + ci) % len(cells)]
                    fx = u_norm * cols - ci
                    fy = v_norm * rows - cj
                    edge = min(fx, 1.0 - fx, fy, 1.0 - fy)
                    v = tone * 0.66 + v * 0.34 + (0.0 if edge > gutter else -0.4)
                field[row + i] = v

        if norm is None:
            lo, hi = min(field), max(field)
        else:
            lo, hi = norm
        span = (hi - lo) or 1.0
        scaled = []
        for value in field:
            normalised = (value - lo) / span
            # Later frames can drift outside frame 0's range; clamping beats
            # re-normalising, which would make the whole clip pulse.
            scaled.append(0.0 if normalised < 0.0 else
                          (1.0 if normalised > 1.0 else normalised))
        return scaled, (lo, hi)

    # -- render ------------------------------------------------------------

    def _paint(
        self,
        field: list[float],
        style: Style,
        grain: list[int],
        width: int,
        height: int,
        fw: int,
        fh: int,
        push: float,
        col_d: list[float],
        inv_r2: float,
        rng_stars: random.Random | None,
        ctx: JobContext,
        base_step: int,
        total_steps: int,
    ) -> bytes:
        """Map one normalised field onto pixels. The hot loop of the engine."""
        lut = style.lut
        cx, cy = width / 2.0, height / 2.0
        out = bytearray(width * height * 3)
        pos = 0
        gi = 0
        x_scale = (fw - 1) / max(1, width - 1)
        y_scale = (fh - 1) / max(1, height - 1)
        glow = style.glow

        for y in range(height):
            if y % 24 == 0:
                ctx.check_cancel()
                ctx.progress(base_step, total_steps, "painting")
            fy = y * y_scale
            y0 = int(fy)
            y1 = min(fh - 1, y0 + 1)
            wy = fy - y0
            row0 = y0 * fw
            row1 = y1 * fw
            dy2 = ((y - cy) ** 2) * inv_r2
            for x in range(width):
                fx = x * x_scale
                x0 = int(fx)
                x1 = x0 + 1 if x0 + 1 < fw else x0
                wx = fx - x0
                a = field[row0 + x0]
                b = field[row0 + x1]
                c = field[row1 + x0]
                d = field[row1 + x1]
                top = a + (b - a) * wx
                bot = c + (d - c) * wx
                v = top + (bot - top) * wy
                v = 0.5 + (v - 0.5) * push
                if v < 0.0:
                    v = 0.0
                elif v > 1.0:
                    v = 1.0

                r, g, bl = lut[int(v * 255)]

                # Slope shading: the horizontal derivative of the field acts as
                # a light direction, which gives flat noise some dimension.
                slope = (b - a) * 6.0
                if slope > 0:
                    lift = slope * 26.0
                    r += lift
                    g += lift
                    bl += lift

                shade = 1.0 - 0.55 * (col_d[x] + dy2)
                n = grain[gi]
                gi = (gi + 1) & 4095
                r = int(r * shade) + n
                g = int(g * shade) + n
                bl = int(bl * shade) + n
                if glow:
                    boost = (v * v) * 22.0
                    r += boost
                    g += boost * 0.9
                    bl += boost * 0.8
                out[pos] = 0 if r < 0 else (255 if r > 255 else int(r))
                out[pos + 1] = 0 if g < 0 else (255 if g > 255 else int(g))
                out[pos + 2] = 0 if bl < 0 else (255 if bl > 255 else int(bl))
                pos += 3

        if rng_stars is not None and style.kind == "cosmic":
            self._scatter_stars(out, width, height, rng_stars)
        return bytes(out)

    def _render_sequence(
        self,
        request: GenerationRequest,
        seed: int,
        ctx: JobContext,
        frame_count: int = 1,
    ) -> tuple[list[bytes], dict[str, Any]]:
        """Render one still, or a seamlessly looping sequence of frames."""
        width, height = request.width, request.height
        # Presets are lens-and-film vocabulary aimed at trained models; this
        # renderer reads colour and composition words, so it takes the prompt
        # as typed.
        prompt, negative = request.composed(neural=False)
        rng = random.Random(f"{seed}:{prompt}:{request.sampler}")
        style = Style(prompt, negative, rng, palette=request.palette)
        octaves = 2 + max(0, min(5, request.steps // 8))
        fw, fh = self._field_size(width, height, request.steps)

        # Drawn once and shared by every frame, so nothing boils between them.
        setup = self._field_setup(rng)
        grain_amp = style.grain
        grain = [rng.randint(-grain_amp, grain_amp) for _ in range(4096)]
        star_seed = rng.randint(0, 2**31 - 1)

        # Guidance behaves like contrast/strength here: higher pushes the
        # palette apart, which is the closest honest analogue to CFG.
        push = max(0.35, min(2.0, request.guidance / 7.0))
        cx, cy = width / 2.0, height / 2.0
        inv_r2 = 1.0 / (cx * cx + cy * cy)
        col_d = [((x - cx) ** 2) * inv_r2 for x in range(width)]

        frame_count = max(1, int(frame_count))
        total_steps = frame_count * 2
        frames: list[bytes] = []
        norm: tuple[float, float] | None = None

        for index in range(frame_count):
            ctx.check_cancel()
            # The last frame would be identical to the first, so the phase
            # stops just short of a full turn and the loop stays even.
            phase = index / frame_count if frame_count > 1 else 0.0
            note = f"frame {index + 1}/{frame_count}" if frame_count > 1 else "composing"
            ctx.progress(index * 2, total_steps, note)

            field, measured = self._build_field(
                style, setup, fw, fh, octaves, ctx, index * 2, total_steps,
                phase=phase, motion=request.motion, norm=norm,
            )
            # Frame 0 fixes the range every later frame is measured against.
            if norm is None:
                norm = measured

            frames.append(self._paint(
                field, style, grain, width, height, fw, fh, push, col_d, inv_r2,
                random.Random(star_seed), ctx, index * 2 + 1, total_steps,
            ))

        ctx.progress(total_steps, total_steps, "done")
        meta = {
            "style": style.kind,
            "palette": ["#%02x%02x%02x" % c for c in style.palette],
            "octaves": octaves,
            "field": f"{fw}x{fh}",
            "palette_source": "reference" if style.from_reference else "prompt",
        }
        return frames, meta

    def _render(
        self,
        request: GenerationRequest,
        seed: int,
        ctx: JobContext,
    ) -> tuple[bytes, dict[str, Any]]:
        frames, meta = self._render_sequence(request, seed, ctx, 1)
        return frames[0], meta

    @staticmethod
    def _scatter_stars(
        buf: bytearray, width: int, height: int, rng: random.Random
    ) -> None:
        count = max(30, (width * height) // 2600)
        for _ in range(count):
            x = rng.randrange(width)
            y = rng.randrange(height)
            brightness = rng.randint(140, 255)
            for dx, dy, falloff in ((0, 0, 1.0), (1, 0, 0.35), (-1, 0, 0.35),
                                    (0, 1, 0.35), (0, -1, 0.35)):
                px, py = x + dx, y + dy
                if 0 <= px < width and 0 <= py < height:
                    idx = (py * width + px) * 3
                    for ch in range(3):
                        value = buf[idx + ch] + int(brightness * falloff)
                        buf[idx + ch] = 255 if value > 255 else value

    # -- engine API --------------------------------------------------------

    def generate(
        self, request: GenerationRequest, ctx: JobContext
    ) -> Iterator[GeneratedMedia]:
        for index in range(request.batch):
            ctx.check_cancel()
            seed = request.seed_for(index)
            started = time.time()
            frame_count = request.frames if request.is_video else 1
            frames, meta = self._render_sequence(request, seed, ctx, frame_count)

            text = {
                "Software": "Avernal Forge",
                "Engine": self.id,
                "Prompt": request.prompt,
                "Negative": request.negative,
                "Seed": str(seed),
                "Steps": str(request.steps),
                "Guidance": str(request.guidance),
                "Style": meta["style"],
            }

            if request.is_video:
                notes: list[str] = []
                data, fmt, mime, ext = encode_video(
                    request.width, request.height, frames,
                    fps=request.fps, text=text, wanted=request.video_format,
                    on_note=notes.append,
                )
                meta["video_format"] = fmt
                meta["motion"] = request.motion
                if notes:
                    meta["note"] = notes[0]
                meta["render_ms"] = int((time.time() - started) * 1000)
                yield GeneratedMedia(
                    data=data, seed=seed, width=request.width, height=request.height,
                    kind="video", mime=mime, ext=ext,
                    frames=len(frames), fps=request.fps, meta=meta,
                )
            else:
                meta["render_ms"] = int((time.time() - started) * 1000)
                yield GeneratedMedia(
                    data=encode_png(request.width, request.height, frames[0], text),
                    seed=seed, width=request.width, height=request.height,
                    kind="image", mime="image/png", ext=".png", meta=meta,
                )
