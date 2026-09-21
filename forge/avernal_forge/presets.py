"""Prompt presets for realistic output.

These are ordinary prompt and negative-prompt additions - the same thing people
type by hand - collected so they are one click instead of remembered folklore.
They only do anything on a trained model: the built-in procedural renderer
reads prompts for colour and composition words, so lens and film vocabulary
would only confuse it. `neural_only` marks that, and the UI greys them out
accordingly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: Faults that show up across nearly every photoreal prompt, worth excluding
#: once rather than retyping.
COMMON_NEGATIVE = (
    "lowres, blurry, out of focus, jpeg artifacts, watermark, signature, text, "
    "deformed, disfigured, extra limbs, extra fingers, fused fingers, "
    "mutated hands, bad anatomy, bad proportions"
)

PEOPLE_NEGATIVE = (
    "plastic skin, waxy skin, airbrushed, doll-like, uncanny, dead eyes, "
    "asymmetrical eyes, extra teeth"
)


@dataclass
class Preset:
    id: str
    label: str
    description: str
    prompt_suffix: str = ""
    negative: str = ""
    #: Suggestions the UI applies when the preset is chosen; never forced.
    suggests: dict[str, Any] = field(default_factory=dict)
    neural_only: bool = True

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "prompt_suffix": self.prompt_suffix,
            "negative": self.negative,
            "suggests": self.suggests,
            "neural_only": self.neural_only,
        }


PRESETS: list[Preset] = [
    Preset(
        id="none",
        label="None",
        description="Your prompt, untouched.",
        neural_only=False,
    ),
    Preset(
        id="photo",
        label="Photographic",
        description="Reads as a photograph rather than an illustration.",
        prompt_suffix=(
            "photograph, natural lighting, realistic textures, sharp focus, "
            "shot on a 50mm lens, high detail"
        ),
        negative=f"illustration, painting, drawing, 3d render, cgi, anime, {COMMON_NEGATIVE}",
        suggests={"steps": 32, "guidance": 6.0},
    ),
    Preset(
        id="portrait",
        label="Portrait of a person",
        description=(
            "Tuned for faces: skin texture, catchlights, and the negatives that "
            "keep hands and eyes from going wrong."
        ),
        prompt_suffix=(
            "portrait photograph, natural skin texture with pores and fine detail, "
            "catchlight in the eyes, soft window light, shallow depth of field, "
            "shot on an 85mm lens at f/2"
        ),
        negative=(
            f"illustration, painting, 3d render, cgi, {PEOPLE_NEGATIVE}, "
            f"{COMMON_NEGATIVE}"
        ),
        suggests={"steps": 36, "guidance": 5.5, "width": 832, "height": 1216,
                  "detail_pass": True},
    ),
    Preset(
        id="cinematic",
        label="Cinematic",
        description="Film-still look: wide frame, shallow focus, graded colour.",
        prompt_suffix=(
            "cinematic film still, anamorphic widescreen, shallow depth of field, "
            "volumetric light, subtle film grain, colour graded"
        ),
        negative=f"flat lighting, snapshot, {COMMON_NEGATIVE}",
        suggests={"steps": 34, "guidance": 6.5, "width": 1216, "height": 832},
    ),
    Preset(
        id="documentary",
        label="Documentary",
        description="Available light, unposed, reportage rather than studio.",
        prompt_suffix=(
            "documentary photograph, available light, candid unposed moment, "
            "35mm reportage, true-to-life colour"
        ),
        negative=f"studio lighting, posed, overprocessed, hdr, {COMMON_NEGATIVE}",
        suggests={"steps": 30, "guidance": 5.0},
    ),
]


def by_id(preset_id: str | None) -> Preset:
    for preset in PRESETS:
        if preset.id == (preset_id or "none"):
            return preset
    return PRESETS[0]


def compose(
    preset_id: str | None,
    prompt: str,
    negative: str = "",
    neural: bool = True,
) -> tuple[str, str]:
    """Return the prompt and negative a pipeline should actually be given.

    The user's own text always comes first, and their negative always wins over
    the preset's, so a preset never quietly overrides what was typed.
    """
    preset = by_id(preset_id)
    if preset.id == "none" or (preset.neural_only and not neural):
        return prompt, negative

    parts = [prompt.strip().rstrip(",")] if prompt.strip() else []
    if preset.prompt_suffix:
        parts.append(preset.prompt_suffix)
    composed_prompt = ", ".join(part for part in parts if part)

    negatives = [negative.strip().rstrip(",")] if negative.strip() else []
    if preset.negative:
        negatives.append(preset.negative)
    composed_negative = ", ".join(part for part in negatives if part)
    return composed_prompt, composed_negative


def describe_for_api() -> list[dict[str, Any]]:
    return [preset.public() for preset in PRESETS]
