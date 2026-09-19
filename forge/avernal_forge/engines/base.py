"""Engine contract shared by every local backend."""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Iterator, Protocol

MAX_SEED = 2**31 - 1

SAMPLERS = [
    {"id": "euler_a", "label": "Euler Ancestral"},
    {"id": "euler", "label": "Euler"},
    {"id": "dpmpp_2m", "label": "DPM++ 2M"},
    {"id": "dpmpp_2m_karras", "label": "DPM++ 2M Karras"},
    {"id": "unipc", "label": "UniPC"},
    {"id": "ddim", "label": "DDIM"},
    {"id": "lms", "label": "LMS"},
    {"id": "heun", "label": "Heun"},
]


def random_seed() -> int:
    return random.randint(0, MAX_SEED)


@dataclass
class GenerationRequest:
    """One user-facing generation request (may expand to several images)."""

    prompt: str = ""
    negative: str = ""
    width: int = 512
    height: int = 512
    steps: int = 24
    guidance: float = 7.0
    seed: int = -1  # -1 means "pick one for me"
    batch: int = 1
    sampler: str = "euler_a"
    model: str | None = None
    init_image: bytes | None = None
    strength: float = 0.6
    #: Hex colours pulled from a reference image, steering the procedural
    #: engine's palette in place of the one derived from the prompt.
    palette: list[str] | None = None
    #: The saved reference this request was built from, for provenance.
    reference_id: str | None = None

    def seed_for(self, index: int) -> int:
        """Seeds within a batch walk forward so a batch is reproducible."""
        base = self.seed if self.seed is not None and self.seed >= 0 else random_seed()
        return (base + index) % (MAX_SEED + 1)

    def to_meta(self) -> dict[str, Any]:
        return {
            "prompt": self.prompt,
            "negative": self.negative,
            "width": self.width,
            "height": self.height,
            "steps": self.steps,
            "guidance": self.guidance,
            "sampler": self.sampler,
            "model": self.model,
            "palette": self.palette,
        }


@dataclass
class GeneratedImage:
    png: bytes
    seed: int
    width: int
    height: int
    meta: dict[str, Any] = field(default_factory=dict)


class Cancelled(Exception):
    """Raised inside an engine when the job was cancelled by the user."""


class JobContext(Protocol):
    """What an engine is allowed to do with the job that is running it."""

    def progress(self, step: int, total: int, note: str = "") -> None: ...
    def check_cancel(self) -> None: ...



class Engine:
    """Base class. Subclasses render images; everything else is shared."""

    id: str = "base"
    label: str = "Engine"
    description: str = ""
    #: True when this engine produces images from trained model weights.
    is_neural: bool = False

    def available(self) -> bool:
        return False

    def unavailable_reason(self) -> str:
        return ""

    def models(self) -> list[dict[str, Any]]:
        return []

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "available": self.available(),
            "reason": self.unavailable_reason(),
            "neural": self.is_neural,
            "device": self.device_label(),
        }

    def device_label(self) -> str:
        return "cpu"

    def generate(
        self, request: GenerationRequest, ctx: JobContext
    ) -> Iterator[GeneratedImage]:
        raise NotImplementedError
