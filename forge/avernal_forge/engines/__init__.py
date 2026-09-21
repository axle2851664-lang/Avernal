"""Engine registry.

Order matters: the first available engine wins when `--engine auto` is used,
so the real-weights backend is preferred and the procedural one is the floor
that always works.
"""

from __future__ import annotations

from typing import Any

from .base import (
    SAMPLERS,
    Cancelled,
    Engine,
    GeneratedImage,
    GeneratedMedia,
    GenerationRequest,
    JobContext,
    random_seed,
)
from .diffusers_engine import DiffusersEngine
from .diffusers_video import DiffusersVideoEngine
from .procedural import ProceduralEngine

__all__ = [
    "SAMPLERS",
    "Cancelled",
    "Engine",
    "EngineRegistry",
    "GeneratedImage",
    "GeneratedMedia",
    "GenerationRequest",
    "JobContext",
    "random_seed",
]


class EngineRegistry:
    def __init__(self, config: Any) -> None:
        self.config = config
        self.engines: list[Engine] = [
            DiffusersEngine(config),
            DiffusersVideoEngine(config),
            ProceduralEngine(),
        ]

    def all(self) -> list[Engine]:
        return list(self.engines)

    def by_id(self, engine_id: str) -> Engine | None:
        for engine in self.engines:
            if engine.id == engine_id:
                return engine
        return None

    def default(self, want_video: bool = False) -> Engine:
        """The engine used when the request does not name one."""
        wanted = (self.config.engine or "auto").lower()
        if wanted != "auto":
            engine = self.by_id(wanted)
            if engine is None:
                raise RuntimeError(f"unknown engine {wanted!r}")
            return engine
        candidates = [
            e for e in self.engines
            if (e.supports_video if want_video else e.supports_image)
        ]
        for engine in candidates:
            if engine.available() and (not engine.is_neural or engine.models()):
                return engine
        if not candidates:
            raise RuntimeError("no engine on this machine can produce video")
        return candidates[-1]

    def resolve(self, engine_id: str | None, want_video: bool = False) -> Engine:
        if not engine_id or engine_id == "auto":
            return self.default(want_video=want_video)
        engine = self.by_id(engine_id)
        if engine is None:
            raise RuntimeError(f"unknown engine {engine_id!r}")
        if not engine.available():
            raise RuntimeError(engine.unavailable_reason() or f"{engine_id} unavailable")
        if want_video and not engine.supports_video:
            raise RuntimeError(
                f"the {engine.label} engine makes stills, not video. Leave the "
                "engine on auto, or pick one that supports video."
            )
        return engine

    def describe(self) -> list[dict[str, Any]]:
        return [engine.describe() for engine in self.engines]

    def models(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for engine in self.engines:
            if engine.available():
                out.extend(engine.models())
        return out
