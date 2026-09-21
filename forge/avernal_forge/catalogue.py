"""A short list of models that are actually good at what people ask for.

Photorealistic people and realistic video come from weights, not from code.
Forge's built-in renderer cannot draw a face and never will - it is a noise
field. This catalogue exists so that getting the weights that *can* is one
command rather than an afternoon of reading model cards.

Entries are deliberately few and well known. Anything not listed can still be
installed by repository id, which is the escape hatch when an entry here goes
stale.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: Files every diffusers pipeline needs. Everything else in a repo - training
#: checkpoints, duplicate precisions, ONNX exports - is skipped.
DIFFUSERS_PATTERNS = (
    "model_index.json",
    "*/config.json",
    "*/*.json",
    "*.json",
    "*/diffusion_pytorch_model.safetensors",
    "*/model.safetensors",
    "*/*.txt",
    "*/spiece.model",
    "*/tokenizer.json",
    "*/merges.txt",
    "*/vocab.json",
)


@dataclass
class CatalogueEntry:
    id: str
    name: str
    repo: str
    kind: str                      # "image" or "video"
    summary: str
    #: What this is genuinely good at, in plain words.
    good_for: str
    approx_gb: float
    vram_gb: float
    licence: str
    #: Gated repos need the licence accepted on the hub and an access token.
    gated: bool = False
    #: True when the model renders convincing people.
    photoreal_people: bool = False
    #: Needs a separate base model to run (AnimateDiff rides on SD 1.5).
    requires: str = ""
    patterns: tuple[str, ...] = field(default_factory=lambda: DIFFUSERS_PATTERNS)
    notes: str = ""

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "repo": self.repo,
            "kind": self.kind,
            "summary": self.summary,
            "good_for": self.good_for,
            "approx_gb": self.approx_gb,
            "vram_gb": self.vram_gb,
            "licence": self.licence,
            "gated": self.gated,
            "photoreal_people": self.photoreal_people,
            "requires": self.requires,
            "notes": self.notes,
        }


CATALOGUE: list[CatalogueEntry] = [
    CatalogueEntry(
        id="sdxl",
        name="Stable Diffusion XL 1.0",
        repo="stabilityai/stable-diffusion-xl-base-1.0",
        kind="image",
        summary="The default choice for photorealistic stills, including people.",
        good_for="Photoreal portraits and scenes at 1024px.",
        approx_gb=6.9,
        vram_gb=8.0,
        licence="CreativeML Open RAIL++-M",
        photoreal_people=True,
        notes="Render at 1024x1024, or 832x1216 for portraits; it was trained there.",
    ),
    CatalogueEntry(
        id="sdxl-turbo",
        name="SDXL Turbo",
        repo="stabilityai/sdxl-turbo",
        kind="image",
        summary="SDXL distilled for speed: usable images in 1-4 steps.",
        good_for="Fast drafts and iteration, including people, at 512px.",
        approx_gb=6.9,
        vram_gb=8.0,
        licence="Stability AI Non-Commercial Research Community License",
        photoreal_people=True,
        notes="Use 1-4 steps and guidance 0. Non-commercial licence - check it.",
    ),
    CatalogueEntry(
        id="sd21",
        name="Stable Diffusion 2.1",
        repo="stabilityai/stable-diffusion-2-1",
        kind="image",
        summary="Smaller and lighter than SDXL; good on modest GPUs.",
        good_for="General stills at 768px when SDXL will not fit.",
        approx_gb=5.2,
        vram_gb=6.0,
        licence="CreativeML Open RAIL++-M",
        photoreal_people=True,
    ),
    CatalogueEntry(
        id="svd",
        name="Stable Video Diffusion (img2vid XT)",
        repo="stabilityai/stable-video-diffusion-img2vid-xt",
        kind="video",
        summary="Turns one still into a short, realistic clip of 25 frames.",
        good_for="Realistic motion from an image you already like.",
        approx_gb=9.6,
        vram_gb=12.0,
        licence="Stability AI Non-Commercial Research Community License",
        gated=True,
        photoreal_people=True,
        notes=(
            "Image-to-video: it needs a starting frame. Accept the licence on the "
            "model page and pass --hf-token to install."
        ),
    ),
    CatalogueEntry(
        id="ltx-video",
        name="LTX-Video",
        repo="Lightricks/LTX-Video",
        kind="video",
        summary="Fast open text-to-video; short clips without a starting image.",
        good_for="Realistic text-to-video clips on a single consumer GPU.",
        approx_gb=9.0,
        vram_gb=12.0,
        licence="RAIL-M (open weights)",
        photoreal_people=True,
    ),
    CatalogueEntry(
        id="animatediff",
        name="AnimateDiff motion adapter (SD 1.5)",
        repo="guoyww/animatediff-motion-adapter-v1-5-2",
        kind="video",
        summary="Adds motion to an SD 1.5 base you already have.",
        good_for="Lightweight text-to-video when VRAM is tight.",
        approx_gb=1.7,
        vram_gb=8.0,
        licence="Apache-2.0",
        requires="an SD 1.5 base model",
        notes="On its own this is only the motion module; it needs an SD 1.5 base.",
    ),
]


def by_id(entry_id: str) -> CatalogueEntry | None:
    for entry in CATALOGUE:
        if entry.id == entry_id:
            return entry
    return None


def listing(kind: str | None = None) -> list[CatalogueEntry]:
    if kind:
        return [entry for entry in CATALOGUE if entry.kind == kind]
    return list(CATALOGUE)


def photoreal_ids() -> set[str]:
    return {entry.id for entry in CATALOGUE if entry.photoreal_people}


def describe_for_api() -> list[dict[str, Any]]:
    return [entry.public() for entry in CATALOGUE]
