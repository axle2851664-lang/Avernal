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
    GenerationRequest,
    JobContext,
    random_seed,
)
from .diffusers_engine import DiffusersEngine
from .procedural import ProceduralEngine

__all__ = [
    "SAMPLERS",
    "Cancelled",
    "Engine",
    "EngineRegistry",
    "GeneratedImage",
    "GenerationRequest",
    "JobContext",
    "random_seed",
]


class EngineRegistry:
    def __init__(self, config: Any) -> None:
        self.config = config
        self.engines: list[Engine] = [DiffusersEngine(config), ProceduralEngine()]

    def all(self) -> list[Engine]:
        return list(self.engines)

    def by_id(self, engine_id: str) -> Engine | None:
        for engine in self.engines:
            if engine.id == engine_id:
                return engine
        return None

    def default(self) -> Engine:
        """The engine used when the request does not name one."""
        wanted = (self.config.engine or "auto").lower()
        if wanted != "auto":
            engine = self.by_id(wanted)
            if engine is None:
                raise RuntimeError(f"unknown engine {wanted!r}")
            return engine
        for engine in self.engines:
            if engine.available() and (not engine.is_neural or engine.models()):
                return engine
        return self.engines[-1]

    def resolve(self, engine_id: str | None) -> Engine:
        if not engine_id or engine_id == "auto":
            return self.default()
        engine = self.by_id(engine_id)
        if engine is None:
            raise RuntimeError(f"unknown engine {engine_id!r}")
        if not engine.available():
            raise RuntimeError(engine.unavailable_reason() or f"{engine_id} unavailable")
        return engine

    def describe(self) -> list[dict[str, Any]]:
        return [engine.describe() for engine in self.engines]

    def models(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for engine in self.engines:
            if engine.available():
                out.extend(engine.models())
        return out
