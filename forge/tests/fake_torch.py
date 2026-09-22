"""Stand-ins for torch, diffusers and PIL.

The diffusers engines are the one part of Forge that cannot run in a plain
environment, and that is exactly where a rename broke `GeneratedImage(png=...)`
without any test noticing. These fakes are deliberately thin: they implement
only what the engines actually touch, so the engines' own logic - model
resolution, scheduler selection, call-argument building, callbacks, media
construction - runs for real.

They prove the wiring, not the imagery. A GPU is still what proves the output.
"""

from __future__ import annotations

import sys
import types
from typing import Any


class FakeImage:
    """Enough of a PIL image for the engine's PIL-free fallback path."""

    def __init__(self, width: int = 64, height: int = 64, fill: int = 120) -> None:
        self.width = width
        self.height = height
        self._fill = fill

    def convert(self, mode: str) -> "FakeImage":
        return self

    def resize(self, size: tuple[int, int]) -> "FakeImage":
        return FakeImage(size[0], size[1], self._fill)

    def tobytes(self) -> bytes:
        return bytes([self._fill, self._fill // 2, self._fill // 3]) * (
            self.width * self.height
        )

    @property
    def size(self) -> tuple[int, int]:
        return (self.width, self.height)


class _Result:
    def __init__(self, images=None, frames=None, flagged=False) -> None:
        if images is not None:
            self.images = images
        if frames is not None:
            self.frames = frames
        self.nsfw_content_detected = [flagged] if images else None


class FakePipeline:
    """Records how it was called so tests can assert on the wiring."""

    last_call: dict[str, Any] = {}

    def __init__(self, kind: str = "txt2img", flagged: bool = False) -> None:
        self.kind = kind
        self.flagged = flagged
        self.scheduler = types.SimpleNamespace(config={"fake": True})
        self.device = "cpu"
        self.moved_to = None
        self.slicing = False

    # -- lifecycle the engine drives -------------------------------------
    def to(self, device):
        self.moved_to = device
        return self

    def enable_attention_slicing(self):
        self.slicing = True

    def enable_vae_slicing(self):
        pass

    def enable_vae_tiling(self):
        pass

    def enable_model_cpu_offload(self):
        pass

    def set_progress_bar_config(self, **kwargs):
        pass

    # -- the call the engine inspects and then makes ----------------------
    def __call__(
        self,
        prompt=None,
        negative_prompt=None,
        image=None,
        strength=None,
        width=None,
        height=None,
        num_inference_steps=None,
        guidance_scale=None,
        num_frames=None,
        fps=None,
        motion_bucket_id=None,
        decode_chunk_size=None,
        generator=None,
        callback_on_step_end=None,
        **extra,
    ):
        FakePipeline.last_call = {
            "prompt": prompt, "negative_prompt": negative_prompt,
            "image": image, "strength": strength, "width": width, "height": height,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance_scale, "num_frames": num_frames,
            "fps": fps, "motion_bucket_id": motion_bucket_id,
            "decode_chunk_size": decode_chunk_size,
        }
        # Drive the progress callback the way a real pipeline would.
        if callback_on_step_end:
            for _ in range(max(1, int(num_inference_steps or 1))):
                callback_on_step_end(self, 0, 0, callback_kwargs={})

        # A real img2img pipeline returns an image the size of its input; the
        # detail pass depends on that, so the fake has to honour it too.
        out_w = width or (image.width if image is not None else 64)
        out_h = height or (image.height if image is not None else 64)

        if self.kind == "video":
            count = int(num_frames or 4)
            return _Result(frames=[[FakeImage(out_w, out_h, 40 + i * 20)
                                    for i in range(count)]])
        return _Result(images=[FakeImage(out_w, out_h)], flagged=self.flagged)


class _AutoText2Image:
    made: list[str] = []

    @classmethod
    def from_pretrained(cls, path, **kwargs):
        cls.made.append(str(path))
        return FakePipeline("txt2img")

    @classmethod
    def from_single_file(cls, path, **kwargs):
        cls.made.append(str(path))
        return FakePipeline("txt2img")


class _AutoImage2Image:
    @classmethod
    def from_pretrained(cls, path, **kwargs):
        return FakePipeline("img2img")

    @classmethod
    def from_pipe(cls, pipe, **kwargs):
        return FakePipeline("img2img")


class _DiffusionPipeline:
    @classmethod
    def from_pretrained(cls, path, **kwargs):
        return FakePipeline("video")


class _Scheduler:
    @classmethod
    def from_config(cls, config, **kwargs):
        return types.SimpleNamespace(config=config, kwargs=kwargs)


class _FakePILImage:
    """Only `open` is needed: the engine decodes an init image with it."""

    @staticmethod
    def open(buffer):
        return FakeImage(64, 64, 200)

    @staticmethod
    def fromarray(array):
        return FakeImage(64, 64, 200)


def install(flagged: bool = False, with_pil: bool = False) -> dict[str, Any]:
    """Put the fakes into sys.modules. Returns what was displaced."""
    saved = {name: sys.modules.get(name)
             for name in ("torch", "torch.backends", "diffusers", "PIL",
                          "PIL.Image")}

    torch = types.ModuleType("torch")
    torch.float16 = "float16"
    torch.float32 = "float32"
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: False,
        get_device_name=lambda i: "Fake GPU",
        get_device_properties=lambda i: types.SimpleNamespace(total_memory=8e9),
    )
    torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(
        is_available=lambda: False))

    class _Generator:
        def __init__(self, device=None):
            self.device = device
            self.seed = None

        def manual_seed(self, seed):
            self.seed = seed
            return self

    torch.Generator = _Generator

    diffusers = types.ModuleType("diffusers")
    diffusers.AutoPipelineForText2Image = _AutoText2Image
    diffusers.AutoPipelineForImage2Image = _AutoImage2Image
    diffusers.DiffusionPipeline = _DiffusionPipeline
    for name in ("EulerAncestralDiscreteScheduler", "EulerDiscreteScheduler",
                 "DPMSolverMultistepScheduler", "UniPCMultistepScheduler",
                 "DDIMScheduler", "LMSDiscreteScheduler", "HeunDiscreteScheduler"):
        setattr(diffusers, name, _Scheduler)

    sys.modules["torch"] = torch
    sys.modules["diffusers"] = diffusers

    if with_pil:
        pil = types.ModuleType("PIL")
        pil.Image = _FakePILImage
        sys.modules["PIL"] = pil
        sys.modules["PIL.Image"] = _FakePILImage
    else:
        # Absent on purpose, so the engine's Pillow-free paths are what run.
        sys.modules.pop("PIL", None)
        sys.modules.pop("PIL.Image", None)
    return saved


def restore(saved: dict[str, Any]) -> None:
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module
