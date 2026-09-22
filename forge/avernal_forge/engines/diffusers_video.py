"""Local video diffusion: Stable Video Diffusion, AnimateDiff, LTX, CogVideoX, Wan.

Like the still-image engine, weights are loaded from disk with
`local_files_only=True`, so this cannot quietly download a model. Which
pipeline you get is decided by the `model_index.json` in the folder you point
it at, and the arguments Forge passes are chosen by inspecting that pipeline's
signature - so a pipeline that wants `num_frames` gets it and one that does not
is left alone.

Image-to-video models (SVD, and the *ImageToVideo* variants) need a starting
frame: attach a reference in the studio, or pass `reference_id`.
"""

from __future__ import annotations

import inspect
import io
import time
from pathlib import Path
from typing import Any, Iterator

from .. import models as model_registry
from ..video import encode_video
from .base import Cancelled, GeneratedMedia, GenerationRequest, JobContext
from .diffusers_engine import DiffusersEngine

#: SVD expresses motion as a bucket, roughly 1-255 with ~127 as the default.
MOTION_BUCKET_MID = 127


class DiffusersVideoEngine(DiffusersEngine):
    id = "diffusers-video"
    label = "Video diffusion (local weights)"
    description = (
        "Runs a local video model - Stable Video Diffusion, AnimateDiff, LTX, "
        "CogVideoX or Wan - entirely on this machine. Never contacts a model hub."
    )
    is_neural = True
    supports_video = True
    supports_image = False

    def models(self) -> list[dict[str, Any]]:
        return model_registry.discover(self.config.models_dir, media="video")

    def unavailable_reason(self) -> str:
        if not self.available():
            return (
                "torch and diffusers are not installed. Run "
                "`pip install -r requirements-local-models.txt` to enable video "
                "diffusion."
            )
        if not self.models():
            return (
                f"no video weights found in {self.config.models_dir}. Copy a "
                "diffusers video model folder (SVD, AnimateDiff, LTX, CogVideoX, "
                "Wan) there."
            )
        return ""

    # ----------------------------------------------------------- loading

    def _load(self, model: dict[str, Any], mode: str) -> Any:
        key = (model["path"], mode)
        if self._pipe is not None and self._pipe_key == key:
            return self._pipe

        import diffusers  # noqa: PLC0415

        device = self.resolve_device()
        dtype = self._dtype()
        # DiffusionPipeline reads model_index.json and returns the right class,
        # which is what lets one engine cover every video architecture.
        pipe = diffusers.DiffusionPipeline.from_pretrained(
            str(Path(model["path"])), torch_dtype=dtype, local_files_only=True
        )
        pipe = pipe.to(device)

        for setter in ("enable_attention_slicing", "enable_vae_slicing",
                       "enable_vae_tiling"):
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

    # -------------------------------------------------------- conversion

    @staticmethod
    def _to_image(frame: Any) -> Any:
        """Accept whatever a pipeline returned and give back an image.

        Frames usually arrive as PIL images already, in which case Pillow is
        not needed at all - only array output requires it, so the import stays
        on that branch.
        """
        if hasattr(frame, "convert") and hasattr(frame, "tobytes"):
            return frame

        try:
            from PIL import Image  # noqa: PLC0415
        except ImportError as exc:  # pragma: no cover - diffusers ships Pillow
            raise RuntimeError(
                "This pipeline returned raw arrays, which need Pillow to "
                "convert. Install Pillow, or `pip install -r "
                "requirements-local-models.txt`."
            ) from exc

        array = frame
        if hasattr(array, "detach"):                 # a torch tensor
            array = array.detach().cpu().numpy()
        if hasattr(array, "dtype") and array.dtype.kind == "f":
            array = (array.clip(0, 1) * 255).astype("uint8")
        if hasattr(array, "shape") and len(array.shape) == 3 and array.shape[0] in (1, 3):
            array = array.transpose(1, 2, 0)          # CHW -> HWC
        return Image.fromarray(array)

    @classmethod
    def _frames_to_rgb(cls, frames: Any) -> tuple[list[bytes], int, int]:
        """Normalise whatever the pipeline returned into raw RGB frames."""
        sequence = frames
        # Video pipelines return a batch: frames[0] is this clip's frame list.
        if isinstance(sequence, (list, tuple)) and sequence and isinstance(
            sequence[0], (list, tuple)
        ):
            sequence = sequence[0]
        elif hasattr(sequence, "shape") and len(getattr(sequence, "shape", ())) == 5:
            sequence = sequence[0]

        out: list[bytes] = []
        size: tuple[int, int] | None = None
        for frame in sequence:
            image = cls._to_image(frame).convert("RGB")
            if size is None:
                size = (image.width, image.height)
            elif (image.width, image.height) != size:
                image = image.resize(size)
            out.append(image.tobytes())
        if not out or size is None:
            raise RuntimeError("the pipeline returned no frames")
        return out, size[0], size[1]

    # -------------------------------------------------------- generation

    def generate(
        self, request: GenerationRequest, ctx: JobContext
    ) -> Iterator[GeneratedMedia]:
        if not self.available():
            raise RuntimeError(self.unavailable_reason())

        available = self.models()
        model = model_registry.resolve(available, request.model or self.config.model)
        if model is None:
            raise RuntimeError(
                f"No local video model matched {request.model!r}. Found: "
                + (", ".join(m["id"] for m in available) or "none")
            )

        with self._lock:
            ctx.progress(0, request.steps, f"loading {model['name']}")
            pipe = self._load(model, "video")
            torch = self._torch()
            device = self.resolve_device()
            params = inspect.signature(pipe.__call__).parameters

            wants_image = "image" in params
            wants_prompt = "prompt" in params
            init = None
            if request.init_image:
                from PIL import Image  # noqa: PLC0415

                init = Image.open(io.BytesIO(request.init_image)).convert("RGB")
                if "width" not in params:
                    # SVD takes its size from the input frame.
                    init = init.resize((request.width, request.height))

            if wants_image and not wants_prompt and init is None:
                raise RuntimeError(
                    f"{model['name']} is an image-to-video model: it needs a "
                    "starting frame. Attach a reference, or generate a still "
                    "first and use it as the starting image."
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
                    ctx.check_cancel()
                    return kwargs.get("callback_kwargs", {}) or {}

                prompt, negative = request.composed(neural=True)
                call: dict[str, Any] = {"generator": generator}
                if wants_prompt:
                    call["prompt"] = prompt
                    if negative and "negative_prompt" in params:
                        call["negative_prompt"] = negative
                if wants_image and init is not None:
                    call["image"] = init
                if "num_inference_steps" in params:
                    call["num_inference_steps"] = request.steps
                if "guidance_scale" in params:
                    call["guidance_scale"] = request.guidance
                if "num_frames" in params:
                    call["num_frames"] = request.frames
                if "width" in params and "height" in params:
                    call["width"] = request.width
                    call["height"] = request.height
                if "fps" in params:
                    call["fps"] = int(request.fps)
                if "motion_bucket_id" in params:
                    call["motion_bucket_id"] = int(
                        max(1, min(255, MOTION_BUCKET_MID * request.motion))
                    )
                if "decode_chunk_size" in params:
                    # Decoding every frame at once is the usual way to run out
                    # of VRAM on SVD.
                    call["decode_chunk_size"] = 8
                if "callback_on_step_end" in params:
                    call["callback_on_step_end"] = on_step
                elif "callback" in params:
                    call["callback"] = lambda step, *_: on_step()
                    call["callback_steps"] = 1

                try:
                    result = pipe(**call)
                except Cancelled:
                    raise
                # The pipeline decides the output size, so the clip is
                # encoded at whatever it produced rather than being resampled.
                frames, width, height = self._frames_to_rgb(result.frames)

                ctx.progress(request.steps, request.steps, "encoding")
                text = {
                    "Software": "Avernal Forge",
                    "Engine": self.id,
                    "Model": model["name"],
                    "Prompt": prompt,
                    "Negative": negative,
                    "Seed": str(seed),
                    "Steps": str(request.steps),
                    "Guidance": str(request.guidance),
                }
                notes: list[str] = []
                data, fmt, mime, ext = encode_video(
                    width, height, frames, fps=request.fps, text=text,
                    wanted=request.video_format, on_note=notes.append,
                )
                yield GeneratedMedia(
                    data=data, seed=seed, width=width, height=height,
                    kind="video", mime=mime, ext=ext,
                    frames=len(frames), fps=request.fps,
                    meta={
                        "model": model["name"],
                        "model_path": model["path"],
                        "pipeline": model.get("pipeline", ""),
                        "device": device,
                        "video_format": fmt,
                        "motion": request.motion,
                        "mode": "image-to-video" if init is not None else "text-to-video",
                        "style": request.style,
                        "final_prompt": prompt,
                        "note": notes[0] if notes else "",
                        "render_ms": int((time.time() - started) * 1000),
                    },
                )
