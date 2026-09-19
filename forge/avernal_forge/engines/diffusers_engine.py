"""Local Stable Diffusion / SDXL backend.

Weights are loaded from disk with `local_files_only=True` on every call, so
this engine cannot silently download anything: if the files are not already on
the machine, it fails with a message telling you what to put where.

Everything here is imported lazily. Forge runs fine with torch absent - the
engine simply reports itself unavailable and the procedural engine is used.
"""

from __future__ import annotations

import inspect
import io
import threading
import time
from pathlib import Path
from typing import Any, Iterator

from .. import models as model_registry
from ..png import encode_png
from .base import Cancelled, Engine, GeneratedImage, GenerationRequest, JobContext

SCHEDULER_MAP: dict[str, tuple[str, dict[str, Any]]] = {
    "euler_a": ("EulerAncestralDiscreteScheduler", {}),
    "euler": ("EulerDiscreteScheduler", {}),
    "dpmpp_2m": ("DPMSolverMultistepScheduler", {}),
    "dpmpp_2m_karras": ("DPMSolverMultistepScheduler", {"use_karras_sigmas": True}),
    "unipc": ("UniPCMultistepScheduler", {}),
    "ddim": ("DDIMScheduler", {}),
    "lms": ("LMSDiscreteScheduler", {}),
    "heun": ("HeunDiscreteScheduler", {}),
}


class DiffusersEngine(Engine):
    id = "diffusers"
    label = "Stable Diffusion (local weights)"
    description = (
        "Runs Stable Diffusion or SDXL entirely on this machine from weights "
        "you already have on disk. Never contacts a model hub."
    )
    is_neural = True

    def __init__(self, config: Any) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._pipe: Any = None
        self._pipe_key: tuple[str, str] | None = None
        self._device: str | None = None
        self._import_error: str = ""

    # -------------------------------------------------------------- probing

    def _torch(self):
        import torch  # noqa: PLC0415 - deliberately lazy

        return torch

    def available(self) -> bool:
        try:
            import torch  # noqa: F401, PLC0415
            import diffusers  # noqa: F401, PLC0415
        except Exception as exc:  # pragma: no cover - depends on environment
            self._import_error = str(exc)
            return False
        return True

    def unavailable_reason(self) -> str:
        if self.available():
            if not self.models():
                return (
                    f"torch and diffusers are installed, but no weights were found in "
                    f"{self.config.models_dir}. Copy a diffusers model folder there."
                )
            return ""
        return (
            "torch and diffusers are not installed. Run "
            "`pip install -r requirements-local-models.txt` to enable this engine."
        )

    def resolve_device(self) -> str:
        if self._device:
            return self._device
        wanted = (self.config.device or "auto").lower()
        try:
            torch = self._torch()
        except Exception:
            self._device = "cpu"
            return self._device
        if wanted != "auto":
            self._device = wanted
        elif torch.cuda.is_available():
            self._device = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            self._device = "mps"
        else:
            self._device = "cpu"
        return self._device

    def device_label(self) -> str:
        if not self.available():
            return "unavailable"
        device = self.resolve_device()
        if device == "cuda":
            try:
                torch = self._torch()
                name = torch.cuda.get_device_name(0)
                vram = torch.cuda.get_device_properties(0).total_memory / 1e9
                return f"cuda ({name}, {vram:.1f} GB)"
            except Exception:
                return "cuda"
        return device

    def models(self) -> list[dict[str, Any]]:
        return model_registry.discover(self.config.models_dir)

    # -------------------------------------------------------------- loading

    def _dtype(self):
        torch = self._torch()
        return torch.float16 if self.resolve_device() == "cuda" else torch.float32

    def _load(self, model: dict[str, Any], mode: str) -> Any:
        """Load (and cache) a pipeline. Serialised: loading twice thrashes VRAM."""
        key = (model["path"], mode)
        if self._pipe is not None and self._pipe_key == key:
            return self._pipe

        import diffusers  # noqa: PLC0415

        device = self.resolve_device()
        dtype = self._dtype()
        path = Path(model["path"])

        if mode == "img2img":
            auto_cls = diffusers.AutoPipelineForImage2Image
        else:
            auto_cls = diffusers.AutoPipelineForText2Image

        if model["kind"] == "checkpoint":
            if not hasattr(auto_cls, "from_single_file"):
                raise RuntimeError(
                    "This diffusers version cannot load single-file checkpoints. "
                    "Upgrade diffusers, or convert the checkpoint to a diffusers folder."
                )
            kwargs: dict[str, Any] = {"torch_dtype": dtype, "local_files_only": True}
            if getattr(self.config, "sd_config", None):
                kwargs["config"] = self.config.sd_config
            try:
                pipe = auto_cls.from_single_file(str(path), **kwargs)
            except Exception as exc:
                raise RuntimeError(
                    f"Could not load checkpoint {path.name} offline: {exc}\n"
                    "Single-file checkpoints also need their pipeline config on disk. "
                    "Pass --sd-config /path/to/diffusers-config-folder, or use a "
                    "diffusers-format model folder instead."
                ) from exc
        else:
            pipe = auto_cls.from_pretrained(
                str(path), torch_dtype=dtype, local_files_only=True
            )

        pipe = pipe.to(device)
        # Memory savers - harmless on big cards, the difference between
        # working and OOM on small ones.
        for setter in ("enable_attention_slicing", "enable_vae_slicing"):
            try:
                getattr(pipe, setter)()
            except Exception:
                pass
        if getattr(self.config, "offload", False):
            try:
                pipe.enable_model_cpu_offload()
            except Exception:
                pass
        if hasattr(pipe, "set_progress_bar_config"):
            pipe.set_progress_bar_config(disable=True)

        self._pipe = pipe
        self._pipe_key = key
        return pipe

    @staticmethod
    def _apply_sampler(pipe: Any, sampler: str) -> str:
        name, kwargs = SCHEDULER_MAP.get(sampler, SCHEDULER_MAP["euler_a"])
        try:
            import diffusers  # noqa: PLC0415

            cls = getattr(diffusers, name)
            pipe.scheduler = cls.from_config(pipe.scheduler.config, **kwargs)
            return sampler
        except Exception:
            return "default"

    # ------------------------------------------------------------ generation

    def _to_png(self, image: Any, text: dict[str, str]) -> bytes:
        """Prefer Pillow (it ships with diffusers) and fall back to our encoder."""
        try:
            from PIL import PngImagePlugin  # noqa: PLC0415

            info = PngImagePlugin.PngInfo()
            for key, value in text.items():
                info.add_text(str(key), str(value))
            buf = io.BytesIO()
            image.convert("RGB").save(buf, format="PNG", pnginfo=info)
            return buf.getvalue()
        except Exception:
            rgb = image.convert("RGB")
            return encode_png(rgb.width, rgb.height, rgb.tobytes(), text)

    def generate(
        self, request: GenerationRequest, ctx: JobContext
    ) -> Iterator[GeneratedImage]:
        if not self.available():
            raise RuntimeError(self.unavailable_reason())

        available = self.models()
        model = model_registry.resolve(available, request.model or self.config.model)
        if model is None:
            raise RuntimeError(
                f"No local model matched {request.model!r}. Found: "
                + (", ".join(m["id"] for m in available) or "none")
            )

        mode = "img2img" if request.init_image else "txt2img"
        with self._lock:
            ctx.progress(0, request.steps, f"loading {model['name']}")
            pipe = self._load(model, mode)
            sampler = self._apply_sampler(pipe, request.sampler)
            torch = self._torch()
            device = self.resolve_device()

            init = None
            if request.init_image:
                from PIL import Image  # noqa: PLC0415

                init = Image.open(io.BytesIO(request.init_image)).convert("RGB")
                init = init.resize((request.width, request.height))

            supports_new_callback = (
                "callback_on_step_end" in inspect.signature(pipe.__call__).parameters
            )

            for index in range(request.batch):
                ctx.check_cancel()
                seed = request.seed_for(index)
                generator = torch.Generator(
                    device="cpu" if device == "mps" else device
                ).manual_seed(seed)
                started = time.time()

                state = {"step": 0}

                def on_step(*args: Any, **kwargs: Any):
                    state["step"] += 1
                    ctx.progress(state["step"], request.steps, "sampling")
                    try:
                        ctx.check_cancel()
                    except Cancelled:
                        raise
                    return kwargs.get("callback_kwargs", {}) or {}

                call_kwargs: dict[str, Any] = {
                    "prompt": request.prompt,
                    "num_inference_steps": request.steps,
                    "guidance_scale": request.guidance,
                    "generator": generator,
                }
                if request.negative:
                    call_kwargs["negative_prompt"] = request.negative
                if init is not None:
                    call_kwargs["image"] = init
                    call_kwargs["strength"] = request.strength
                else:
                    call_kwargs["width"] = request.width
                    call_kwargs["height"] = request.height
                if supports_new_callback:
                    call_kwargs["callback_on_step_end"] = on_step
                else:
                    call_kwargs["callback"] = lambda step, *_: on_step()
                    call_kwargs["callback_steps"] = 1

                result = pipe(**call_kwargs)
                image = result.images[0]
                elapsed = int((time.time() - started) * 1000)

                text = {
                    "Software": "Avernal Forge",
                    "Engine": self.id,
                    "Model": model["name"],
                    "Prompt": request.prompt,
                    "Negative": request.negative,
                    "Seed": str(seed),
                    "Steps": str(request.steps),
                    "Guidance": str(request.guidance),
                    "Sampler": sampler,
                }
                yield GeneratedImage(
                    png=self._to_png(image, text),
                    seed=seed,
                    width=image.width,
                    height=image.height,
                    meta={
                        "model": model["name"],
                        "model_path": model["path"],
                        "sampler": sampler,
                        "device": device,
                        "mode": mode,
                        "render_ms": elapsed,
                    },
                )
